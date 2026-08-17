package com.a620.tablet.training

import a620.CanonicalJson
import a620.RetryPolicy
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class ClaimedControllerMessage(
    val messageId: String,
    val runtimeSessionId: String,
    val messageType: String,
    val senderSeq: Long,
    val canonicalSha256: String,
    val canonicalJson: ByteArray,
    val attemptCount: Int,
    val claimGeneration: Long,
)

interface ControllerOutboxStore {
    fun claimDueControllerOutbox(
        runtimeSessionId: String,
        ownerId: String,
        nowUtcMs: Long,
        leaseMs: Long,
        limit: Int,
    ): List<ClaimedControllerMessage>

    fun markControllerOutboxSubmitted(
        messageId: String,
        ownerId: String,
        claimGeneration: Long,
    )

    /** Earliest wake-up for the smallest unresolved sender sequence. */
    fun nextControllerOutboxDueAtUtcMs(runtimeSessionId: String): Long?

    fun markControllerOutboxRetry(
        messageId: String,
        ownerId: String,
        claimGeneration: Long,
        nextAttemptAtUtcMs: Long,
        error: String,
    )

    fun markControllerOutboxPoisoned(
        messageId: String,
        ownerId: String,
        claimGeneration: Long,
        error: String,
    )
}

data class OutboxDispatchSummary(
    val claimed: Int,
    val submitted: Int,
    val retried: Int,
    val poisoned: Int,
)

/**
 * Durable controller sender.
 *
 * A successful SQLite result commit never depends on immediate Binder delivery.
 * The canonical ACK stays in the outbox, is claimed with a fencing generation,
 * and is retried with the original messageId/senderSeq/canonical bytes.
 */
class ControllerOutboxDispatcher(
    private val runtimeSessionId: String,
    private val store: ControllerOutboxStore,
    private val sender: CanonicalControllerSender,
    private val onFatalFailure: (String) -> Unit,
    private val ownerId: String = "OUTBOX-${UUID.randomUUID()}",
    private val nowUtcMs: () -> Long = System::currentTimeMillis,
    private val claimLeaseMs: Long = 15_000,
    private val batchLimit: Int = 16,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val executor = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "a620-controller-outbox").apply { isDaemon = true }
    }.apply { removeOnCancelPolicy = true }

    init {
        require(runtimeSessionId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")))
        require(ownerId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")))
        require(claimLeaseMs in 1..300_000)
        require(batchLimit in 1..64)
    }

    fun scheduleDrain(delayMs: Long = 0) {
        if (closed.get()) return
        require(delayMs >= 0)
        executor.schedule({
            if (closed.get()) return@schedule
            try {
                drainOnce()
            } catch (error: Throwable) {
                onFatalFailure("CONTROLLER_OUTBOX_DISPATCH_FAILURE:${error.message ?: error::class.java.simpleName}")
            }
        }, delayMs, TimeUnit.MILLISECONDS)
    }

    /**
     * Sends a contiguous prefix of the controller sender sequence.
     *
     * The store deliberately returns at most the smallest unresolved sequence
     * for each claim. We claim again only after that message has been submitted,
     * so a retrying earlier message can never be leapfrogged by a later one.
     */
    fun drainOnce(): OutboxDispatchSummary {
        check(!closed.get()) { "outbox dispatcher is closed" }
        var claimedCount = 0
        var submitted = 0
        var retried = 0
        var poisoned = 0

        for (ignored in 0 until batchLimit) {
            val now = nowUtcMs()
            require(now in 0..CanonicalJson.SAFE_INTEGER_MAX)
            val claimed = store.claimDueControllerOutbox(
                runtimeSessionId,
                ownerId,
                now,
                claimLeaseMs,
                1,
            )
            if (claimed.isEmpty()) break
            check(claimed.size == 1) { "outbox store must serialize sender sequence claims" }
            val message = claimed.single()
            claimedCount += 1
            if (message.runtimeSessionId != runtimeSessionId) {
                onFatalFailure("CROSS_RUNTIME_OUTBOX_CLAIM:${message.messageId}")
                throw IllegalStateException("outbox store returned another runtime session")
            }
            val envelope = try {
                verifyClaim(message)
            } catch (error: Throwable) {
                store.markControllerOutboxPoisoned(
                    message.messageId,
                    ownerId,
                    message.claimGeneration,
                    (error.message ?: error::class.java.simpleName).take(256),
                )
                poisoned += 1
                onFatalFailure("CORRUPT_CONTROLLER_OUTBOX:${message.messageId}")
                break
            }

            try {
                sender.send(envelope, message.canonicalJson)
                // A oneway Binder return is transport submission, not proof that
                // the remote reducer processed the message. RESULT_READY replay
                // reopens the exact committed ACK if Cocos did not observe it.
                store.markControllerOutboxSubmitted(message.messageId, ownerId, message.claimGeneration)
                submitted += 1
            } catch (error: Throwable) {
                val completedAttempts = message.attemptCount + 1
                val delay = RetryPolicy.delayMs(completedAttempts)
                val next = Math.addExact(nowUtcMs(), delay)
                require(next <= CanonicalJson.SAFE_INTEGER_MAX)
                store.markControllerOutboxRetry(
                    message.messageId,
                    ownerId,
                    message.claimGeneration,
                    next,
                    (error.message ?: error::class.java.simpleName).take(256),
                )
                retried += 1
                break
            }
        }

        store.nextControllerOutboxDueAtUtcMs(runtimeSessionId)?.let { due ->
            val delay = (due - nowUtcMs()).coerceAtLeast(0L)
            scheduleDrain(delay)
        }
        return OutboxDispatchSummary(claimedCount, submitted, retried, poisoned)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        executor.shutdownNow()
    }

    private fun verifyClaim(message: ClaimedControllerMessage): RuntimeWireEnvelope {
        require(message.attemptCount >= 0)
        require(message.claimGeneration >= 1)
        val actualHash = MessageDigest.getInstance("SHA-256")
            .digest(message.canonicalJson)
            .joinToString("") { "%02x".format(it) }
        require(actualHash == message.canonicalSha256) { "outbox canonical hash mismatch" }
        val envelope = RuntimeWireEnvelopeParser.parseCanonical(
            canonicalBytes = message.canonicalJson,
            declaredMessageType = message.messageType,
            declaredMessageId = message.messageId,
            declaredSenderSeq = message.senderSeq,
            expectedSenderRole = "ANDROID_CONTROLLER",
        )
        require(envelope.runtimeSessionId == message.runtimeSessionId) { "outbox runtime identity mismatch" }
        return envelope
    }
}
