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
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Strict ingress boundary shared by controller and training processes.
 *
 * Inline JSON is bounded and parsed on the Binder caller. Bulk PFD I/O happens
 * off the reducer actor. An ordered sequencer preserves original Binder ingress
 * order, so a fast later message cannot pass an earlier slow bulk payload.
 */
class CanonicalIngressCoordinator(
    private val expectedSenderRole: String,
    private val actor: TrainingRuntimeActor,
    private val sink: RuntimeMessageSink,
    private val requireLiveGeneration: (Long) -> Unit,
) {
    private sealed interface PreparedIngress {
        data class Valid(
            val envelope: RuntimeWireEnvelope,
            val canonicalJson: ByteArray,
            val generation: Long,
        ) : PreparedIngress
        data class Invalid(val messageId: String?, val reason: String) : PreparedIngress
    }

    private val closed = AtomicBoolean(false)
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
    ) {
        check(!closed.get()) { "ingress coordinator is closed" }
        requireLiveGeneration(generation)
        require(canonicalJson.size in 1..RuntimePolicy.INLINE_CANONICAL_MAX_BYTES)
        validateHashSyntax(canonicalSha256)
        val ownedBytes = canonicalJson.copyOf()
        val token = orderedIngress.register(ownedBytes.size)
        val prepared = prepare(
            declaredMessageType,
            declaredMessageId,
            declaredSenderSeq,
            ownedBytes,
            canonicalSha256,
            generation,
        )
        completeOrdered(token, prepared)
    }

    fun submitBulk(
        declaredMessageType: String,
        declaredMessageId: String,
        declaredSenderSeq: Long,
        payloadFd: ParcelFileDescriptor,
        byteLength: Long,
        canonicalSha256: String,
        generation: Long,
    ) {
        check(!closed.get()) { "ingress coordinator is closed" }
        requireLiveGeneration(generation)
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
            completeOrdered(token, PreparedIngress.Invalid(declaredMessageId, "BULK_FD_DUP_FAILED"))
            throw error
        }
        val finished = AtomicBoolean(false)
        val timeout = timeoutExecutor.schedule({
            if (finished.compareAndSet(false, true)) {
                try { ownedFd.close() } catch (_: Throwable) { }
                lease.close()
                completeOrdered(token, PreparedIngress.Invalid(declaredMessageId, "BULK_PAYLOAD_LEASE_EXPIRED"))
            }
        }, RuntimePolicy.BULK_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)

        try {
            bulkExecutor.execute {
                if (finished.get()) return@execute
                val prepared = try {
                    val bytes = ownedFd.use { readLimited(it, byteLength.toInt()) }
                    prepare(
                        declaredMessageType,
                        declaredMessageId,
                        declaredSenderSeq,
                        bytes,
                        canonicalSha256,
                        generation,
                    )
                } catch (error: Throwable) {
                    PreparedIngress.Invalid(declaredMessageId, error.message ?: error::class.java.simpleName)
                }
                if (finished.compareAndSet(false, true)) {
                    timeout.cancel(false)
                    lease.close()
                    completeOrdered(token, prepared)
                }
                try { ownedFd.close() } catch (_: Throwable) { }
            }
        } catch (error: RejectedExecutionException) {
            if (finished.compareAndSet(false, true)) {
                timeout.cancel(false)
                lease.close()
                ownedFd.close()
                completeOrdered(token, PreparedIngress.Invalid(declaredMessageId, "BULK_IO_QUEUE_SATURATED"))
            }
            throw error
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        bulkExecutor.shutdownNow()
        timeoutExecutor.shutdownNow()
        orderedIngress.close()
    }

    private fun prepare(
        declaredMessageType: String,
        declaredMessageId: String,
        declaredSenderSeq: Long,
        canonicalJson: ByteArray,
        canonicalSha256: String,
        generation: Long,
    ): PreparedIngress = try {
        requireLiveGeneration(generation)
        require(sha256Hex(canonicalJson) == canonicalSha256) { "canonical payload hash mismatch" }
        val envelope = RuntimeWireEnvelopeParser.parseCanonical(
            canonicalBytes = canonicalJson,
            declaredMessageType = declaredMessageType,
            declaredMessageId = declaredMessageId,
            declaredSenderSeq = declaredSenderSeq,
            expectedSenderRole = expectedSenderRole,
        )
        PreparedIngress.Valid(envelope, canonicalJson, generation)
    } catch (error: Throwable) {
        PreparedIngress.Invalid(declaredMessageId, error.message ?: error::class.java.simpleName)
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
                        requireLiveGeneration(prepared.generation)
                        sink.onCanonicalMessage(prepared.envelope, prepared.canonicalJson)
                    }
                } catch (error: RejectedExecutionException) {
                    if (prepared.envelope.messageType in RuntimePolicy.DROPPABLE_ON_BACKPRESSURE_MESSAGE_TYPES) {
                        sink.onTelemetryDropped(prepared.envelope.messageId, prepared.envelope.messageType)
                    } else throw error
                }
            }
            is PreparedIngress.Invalid -> actor.submit(RuntimeIngressPriority.URGENT, 1) {
                sink.onProtocolViolation(prepared.messageId, prepared.reason.ifBlank { "PROTOCOL_VIOLATION" })
            }
        }
    }

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

    private fun validateHashSyntax(value: String) {
        require(value.matches(Regex("[0-9a-f]{64}"))) { "invalid canonical SHA-256" }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
