package com.a620.tablet.training

import android.os.ParcelFileDescriptor
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import a620.shell.IngressBudget
import java.security.MessageDigest
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Training-process event sender. Small events remain inline; large canonical
 * payloads are streamed through a pipe so Binder only carries a descriptor.
 *
 * Callers must invoke [send] from the single game/runtime actor. The callback
 * invocation itself is kept in that order. The controller ingress sequencer
 * then prevents a later inline event from passing an earlier bulk event while
 * the pipe is still being read.
 */
internal class RuntimeEventTransport(
    private val channelProvider: () -> TrainingRuntimeService.CallbackChannel?,
    private val onFatalFailure: (String) -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val activeWriteEnds = ConcurrentHashMap.newKeySet<ParcelFileDescriptor>()
    private val bulkBudget = IngressBudget(
        RuntimePolicy.MAX_INFLIGHT_BULK_MESSAGES,
        RuntimePolicy.MAX_INFLIGHT_BULK_BYTES,
    )
    private val writerExecutor = ThreadPoolExecutor(
        RuntimePolicy.BULK_IO_WORKERS,
        RuntimePolicy.BULK_IO_WORKERS,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(RuntimePolicy.BULK_IO_QUEUE_MAX_MESSAGES),
        { runnable -> Thread(runnable, "a620-bulk-egress").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )

    fun send(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        check(!closed.get()) { "runtime event transport is closed" }
        require(envelope.senderRole == "COCOS_RUNTIME") { "only COCOS_RUNTIME events may use callback transport" }
        require(canonicalJson.isNotEmpty() && canonicalJson.size <= RuntimePolicy.BULK_CANONICAL_MAX_BYTES)
        val reparsed = RuntimeWireEnvelopeParser.parseCanonical(
            canonicalBytes = canonicalJson,
            declaredMessageType = envelope.messageType,
            declaredMessageId = envelope.messageId,
            declaredSenderSeq = envelope.senderSeq,
            expectedSenderRole = "COCOS_RUNTIME",
        )
        require(reparsed == envelope) { "event envelope differs from canonical payload" }
        val sha256 = sha256Hex(canonicalJson)
        val channel = requireNotNull(channelProvider()) { "controller callback channel is unavailable" }

        if (canonicalJson.size <= RuntimePolicy.INLINE_CANONICAL_MAX_BYTES) {
            channel.callback.onInlineEvent(
                envelope.messageType,
                envelope.messageId,
                envelope.senderSeq,
                canonicalJson.copyOf(),
                sha256,
                channel.token,
                channel.generation,
            )
            return
        }

        sendBulk(channel, envelope, canonicalJson.copyOf(), sha256)
    }

    private fun sendBulk(
        channel: TrainingRuntimeService.CallbackChannel,
        envelope: RuntimeWireEnvelope,
        canonicalJson: ByteArray,
        sha256: String,
    ) {
        val lease = bulkBudget.reserve(canonicalJson.size)
        val pipe = try {
            ParcelFileDescriptor.createPipe()
        } catch (error: Throwable) {
            lease.close()
            throw error
        }
        require(pipe.size == 2) { "ParcelFileDescriptor.createPipe must return read/write pair" }
        val readEnd = pipe[0]
        val writeEnd = pipe[1]
        activeWriteEnds += writeEnd
        try {
            writerExecutor.execute {
                try {
                    ParcelFileDescriptor.AutoCloseOutputStream(writeEnd).use { output ->
                        output.write(canonicalJson)
                        output.flush()
                    }
                } catch (error: Throwable) {
                    if (!closed.get() && isCurrentChannel(channel)) {
                        onFatalFailure("BULK_EGRESS_WRITE_FAILED: ${error.message ?: error::class.java.simpleName}")
                    }
                } finally {
                    activeWriteEnds.remove(writeEnd)
                    try { writeEnd.close() } catch (_: Throwable) { }
                    lease.close()
                }
            }
        } catch (error: RejectedExecutionException) {
            activeWriteEnds.remove(writeEnd)
            lease.close()
            try { readEnd.close() } catch (_: Throwable) { }
            try { writeEnd.close() } catch (_: Throwable) { }
            throw error
        }

        try {
            channel.callback.onBulkEvent(
                envelope.messageType,
                envelope.messageId,
                envelope.senderSeq,
                readEnd,
                canonicalJson.size.toLong(),
                sha256,
                channel.token,
                channel.generation,
            )
        } catch (error: Throwable) {
            try { writeEnd.close() } catch (_: Throwable) { }
            throw error
        } finally {
            // AIDL or the in-process callback duplicates/owns its descriptor.
            try { readEnd.close() } catch (_: Throwable) { }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        activeWriteEnds.toList().forEach { descriptor ->
            try { descriptor.close() } catch (_: Throwable) { }
            activeWriteEnds.remove(descriptor)
        }
        writerExecutor.shutdownNow()
    }

    private fun isCurrentChannel(expected: TrainingRuntimeService.CallbackChannel): Boolean {
        val current = channelProvider() ?: return false
        return current.generation == expected.generation &&
            ChannelAuthenticator.constantTimeSameToken(current.token, expected.token)
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
