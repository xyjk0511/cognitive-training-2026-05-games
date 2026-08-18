package com.a620.tablet.training

import android.os.ParcelFileDescriptor
import a620.RuntimeIngressPriority
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import a620.shell.IngressBudget
import a620.shell.OrderedIngressSequencer
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Strict ingress boundary shared by controller and training processes.
 *
 * Every asynchronously prepared item retains both generation and channel token.
 * The fence is checked at receipt, before parsing and again on the reducer actor.
 * This is required because a new process binding may start a new token epoch and
 * reset its local generation counter while an old bulk read is still pending.
 */
class CanonicalIngressCoordinator(
    private val expectedSenderRole: String,
    private val actor: TrainingRuntimeActor,
    private val sink: RuntimeMessageSink,
    private val bulkReadTimeoutMs: Long = RuntimePolicy.BULK_READ_TIMEOUT_MS,
    private val isLiveChannel: (Long, String) -> Boolean,
) {
    init { require(bulkReadTimeoutMs > 0) }

    private data class ChannelFence(val generation: Long, val token: String)

    private sealed interface PreparedIngress {
        val messageId: String?
        val fence: ChannelFence

        data class Valid(
            val envelope: RuntimeWireEnvelope,
            val canonicalJson: ByteArray,
            override val fence: ChannelFence,
        ) : PreparedIngress {
            override val messageId: String = envelope.messageId
        }

        data class Invalid(
            override val messageId: String?,
            val reason: String,
            override val fence: ChannelFence,
        ) : PreparedIngress

        data class Stale(
            override val messageId: String?,
            val reason: String,
            override val fence: ChannelFence,
        ) : PreparedIngress
    }

    private class BulkOperation(
        val fd: ParcelFileDescriptor,
        val lease: IngressBudget.Lease,
        val finished: AtomicBoolean = AtomicBoolean(false),
        @Volatile var timeout: ScheduledFuture<*>? = null,
    )

    private val closed = AtomicBoolean(false)
    private val inFlightBulk = ConcurrentHashMap<Long, BulkOperation>()
    private val orderedIngress = OrderedIngressSequencer<PreparedIngress>(
        maxPendingMessages = RuntimePolicy.ACTOR_QUEUE_MAX_MESSAGES + RuntimePolicy.MAX_INFLIGHT_BULK_MESSAGES,
        maxPendingBytes = RuntimePolicy.ACTOR_QUEUE_MAX_BYTES + RuntimePolicy.MAX_INFLIGHT_BULK_BYTES,
    )
    private val bulkBudget = IngressBudget(
        RuntimePolicy.MAX_INFLIGHT_BULK_MESSAGES,
        RuntimePolicy.MAX_INFLIGHT_BULK_BYTES,
    )
    private val bulkExecutor = ThreadPoolExecutor(
        RuntimePolicy.BULK_IO_WORKERS,
        RuntimePolicy.BULK_IO_WORKERS,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(RuntimePolicy.BULK_IO_QUEUE_MAX_MESSAGES),
        { runnable -> Thread(runnable, "a620-bulk-ingress").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )
    private val timeoutExecutor = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "a620-bulk-timeout").apply { isDaemon = true }
    }.apply { removeOnCancelPolicy = true }

    fun submitInline(
        declaredMessageType: String,
        declaredMessageId: String,
        declaredSenderSeq: Long,
        canonicalJson: ByteArray,
        canonicalSha256: String,
        generation: Long,
        channelToken: String,
    ) {
        check(!closed.get()) { "ingress coordinator is closed" }
        val fence = liveFenceOrThrow(generation, channelToken)
        require(canonicalJson.size in 1..RuntimePolicy.INLINE_CANONICAL_MAX_BYTES)
        validateHashSyntax(canonicalSha256)
        val ownedBytes = canonicalJson.copyOf()
        val token = orderedIngress.register(ownedBytes.size)
        completeOrdered(
            token,
            prepare(
                declaredMessageType,
                declaredMessageId,
                declaredSenderSeq,
                ownedBytes,
                canonicalSha256,
                fence,
            ),
        )
    }

    fun submitBulk(
        declaredMessageType: String,
        declaredMessageId: String,
        declaredSenderSeq: Long,
        payloadFd: ParcelFileDescriptor,
        byteLength: Long,
        canonicalSha256: String,
        generation: Long,
        channelToken: String,
    ) {
        check(!closed.get()) { "ingress coordinator is closed" }
        val fence = liveFenceOrThrow(generation, channelToken)
        require(byteLength in 1..RuntimePolicy.BULK_CANONICAL_MAX_BYTES.toLong())
        validateHashSyntax(canonicalSha256)
        val lease = bulkBudget.reserve(byteLength.toInt())
        val token = try {
            orderedIngress.register(byteLength.toInt())
        } catch (error: Throwable) {
            lease.close()
            throw error
        }
        val ownedFd = try {
            ParcelFileDescriptor.dup(payloadFd.fileDescriptor)
        } catch (error: Throwable) {
            lease.close()
            completeOrdered(token, invalidOrStale(declaredMessageId, "BULK_FD_DUP_FAILED", fence))
            throw error
        }
        val operation = BulkOperation(ownedFd, lease)
        inFlightBulk[token.ordinal] = operation
        try {
            operation.timeout = timeoutExecutor.schedule({
                finishBulk(
                    token,
                    operation,
                    invalidOrStale(declaredMessageId, "BULK_PAYLOAD_LEASE_EXPIRED", fence),
                )
            }, bulkReadTimeoutMs, TimeUnit.MILLISECONDS)
        } catch (error: Throwable) {
            finishBulk(token, operation, null)
            throw error
        }

        try {
            bulkExecutor.execute {
                if (operation.finished.get()) return@execute
                val prepared = try {
                    val bytes = readLimited(ownedFd, byteLength.toInt())
                    prepare(
                        declaredMessageType,
                        declaredMessageId,
                        declaredSenderSeq,
                        bytes,
                        canonicalSha256,
                        fence,
                    )
                } catch (error: Throwable) {
                    invalidOrStale(
                        declaredMessageId,
                        error.message ?: error::class.java.simpleName,
                        fence,
                    )
                }
                finishBulk(token, operation, prepared)
            }
        } catch (error: RejectedExecutionException) {
            finishBulk(
                token,
                operation,
                invalidOrStale(declaredMessageId, "BULK_IO_QUEUE_SATURATED", fence),
            )
            throw error
        }
    }

    internal fun resourceSnapshotForTest(): IngressResourceSnapshot {
        val budget = bulkBudget.snapshot()
        val ordered = orderedIngress.snapshot()
        return IngressResourceSnapshot(
            closed = closed.get(),
            inFlightBulkMessages = inFlightBulk.size,
            reservedBulkMessages = budget.first,
            reservedBulkBytes = budget.second,
            orderedPendingMessages = ordered.first,
            orderedPendingBytes = ordered.second,
        )
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        bulkExecutor.shutdownNow()
        timeoutExecutor.shutdownNow()
        inFlightBulk.entries.toList().forEach { (ordinal, operation) ->
            if (operation.finished.compareAndSet(false, true)) {
                operation.timeout?.cancel(false)
                closeQuietly(operation.fd)
                operation.lease.close()
                inFlightBulk.remove(ordinal, operation)
            }
        }
        orderedIngress.close()
    }

    private fun finishBulk(
        token: OrderedIngressSequencer.Token,
        operation: BulkOperation,
        prepared: PreparedIngress?,
    ) {
        if (!operation.finished.compareAndSet(false, true)) return
        operation.timeout?.cancel(false)
        closeQuietly(operation.fd)
        operation.lease.close()
        inFlightBulk.remove(token.ordinal, operation)
        if (prepared != null && !closed.get()) completeOrdered(token, prepared)
    }

    private fun prepare(
        declaredMessageType: String,
        declaredMessageId: String,
        declaredSenderSeq: Long,
        canonicalJson: ByteArray,
        canonicalSha256: String,
        fence: ChannelFence,
    ): PreparedIngress {
        if (!isLive(fence)) return PreparedIngress.Stale(declaredMessageId, "CHANNEL_ROTATED_BEFORE_PARSE", fence)
        return try {
            require(sha256Hex(canonicalJson) == canonicalSha256) { "canonical payload hash mismatch" }
            val envelope = RuntimeWireEnvelopeParser.parseCanonical(
                canonicalBytes = canonicalJson,
                declaredMessageType = declaredMessageType,
                declaredMessageId = declaredMessageId,
                declaredSenderSeq = declaredSenderSeq,
                expectedSenderRole = expectedSenderRole,
            )
            PreparedIngress.Valid(envelope, canonicalJson, fence)
        } catch (error: Throwable) {
            invalidOrStale(declaredMessageId, error.message ?: error::class.java.simpleName, fence)
        }
    }

    private fun completeOrdered(
        token: OrderedIngressSequencer.Token,
        prepared: PreparedIngress,
    ) {
        if (closed.get()) return
        try {
            orderedIngress.complete(token, prepared, ::dispatchPrepared)
        } catch (error: Throwable) {
            orderedIngress.close()
            sink.onFatalInfrastructureFailure(
                "ORDERED_INGRESS_DISPATCH_FAILED: ${error.message ?: error::class.java.simpleName}",
            )
            throw error
        }
    }

    private fun dispatchPrepared(prepared: PreparedIngress) {
        when (prepared) {
            is PreparedIngress.Valid -> {
                val priority = if (prepared.envelope.messageType in RuntimePolicy.URGENT_MESSAGE_TYPES) {
                    RuntimeIngressPriority.URGENT
                } else RuntimeIngressPriority.NORMAL
                try {
                    actor.submit(priority, prepared.canonicalJson.size) {
                        if (!isLive(prepared.fence)) {
                            sink.onStaleChannelMessage(prepared.messageId, "CHANNEL_ROTATED_BEFORE_REDUCER")
                            return@submit
                        }
                        sink.onCanonicalMessage(prepared.envelope, prepared.canonicalJson)
                    }
                } catch (error: RejectedExecutionException) {
                    if (prepared.envelope.messageType in RuntimePolicy.DROPPABLE_ON_BACKPRESSURE_MESSAGE_TYPES) {
                        sink.onTelemetryDropped(prepared.envelope.messageId, prepared.envelope.messageType)
                    } else throw error
                }
            }
            is PreparedIngress.Invalid -> actor.submit(RuntimeIngressPriority.URGENT, 1) {
                if (!isLive(prepared.fence)) {
                    sink.onStaleChannelMessage(prepared.messageId, "CHANNEL_ROTATED_BEFORE_VIOLATION_COMMIT")
                } else {
                    sink.onProtocolViolation(prepared.messageId, prepared.reason.ifBlank { "PROTOCOL_VIOLATION" })
                }
            }
            is PreparedIngress.Stale -> actor.submit(RuntimeIngressPriority.URGENT, 1) {
                sink.onStaleChannelMessage(prepared.messageId, prepared.reason)
            }
        }
    }

    private fun invalidOrStale(messageId: String?, reason: String, fence: ChannelFence): PreparedIngress =
        if (isLive(fence)) PreparedIngress.Invalid(messageId, reason, fence)
        else PreparedIngress.Stale(messageId, "STALE_CHANNEL:$reason", fence)

    private fun liveFenceOrThrow(generation: Long, channelToken: String): ChannelFence {
        val fence = ChannelFence(generation, channelToken)
        require(isLive(fence)) { "stale or unauthenticated channel" }
        return fence
    }

    private fun isLive(fence: ChannelFence): Boolean =
        !closed.get() && isLiveChannel(fence.generation, fence.token)

    private fun readLimited(fd: ParcelFileDescriptor, declaredLength: Int): ByteArray {
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { input ->
            val output = ByteArrayOutputStream(declaredLength)
            val buffer = ByteArray(16 * 1024)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                require(total <= declaredLength && total <= RuntimePolicy.BULK_CANONICAL_MAX_BYTES) {
                    "bulk payload exceeds declared or configured limit"
                }
                output.write(buffer, 0, count)
            }
            require(total == declaredLength) { "bulk length mismatch" }
            return output.toByteArray()
        }
    }

    private fun closeQuietly(fd: ParcelFileDescriptor) {
        try { fd.close() } catch (_: Throwable) { }
    }

    private fun validateHashSyntax(value: String) {
        require(value.matches(Regex("[0-9a-f]{64}"))) { "invalid canonical SHA-256" }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}


data class IngressResourceSnapshot(
    val closed: Boolean,
    val inFlightBulkMessages: Int,
    val reservedBulkMessages: Int,
    val reservedBulkBytes: Int,
    val orderedPendingMessages: Int,
    val orderedPendingBytes: Int,
)
