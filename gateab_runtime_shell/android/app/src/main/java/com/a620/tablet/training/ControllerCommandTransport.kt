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

/** Business/controller code receives this surface, never the generated AIDL interface. */
interface ControllerCommandChannel {
    fun submitInline(
        messageType: String,
        messageId: String,
        senderSeq: Long,
        canonicalJson: ByteArray,
        canonicalSha256: String,
    )

    /** Caller retains ownership of [payloadFd]. */
    fun submitBulk(
        messageType: String,
        messageId: String,
        senderSeq: Long,
        payloadFd: ParcelFileDescriptor,
        byteLength: Long,
        canonicalSha256: String,
    )
}

/** Main-process counterpart of [RuntimeEventTransport], including bounded PFD egress. */
class ControllerCommandTransport(
    private val channel: ControllerCommandChannel,
    private val onFatalFailure: (String) -> Unit,
) : CanonicalControllerSender, AutoCloseable {
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
        { runnable -> Thread(runnable, "a620-controller-bulk-egress").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )

    override fun send(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        check(!closed.get()) { "controller command transport is closed" }
        require(envelope.senderRole == "ANDROID_CONTROLLER")
        require(canonicalJson.size in 1..RuntimePolicy.BULK_CANONICAL_MAX_BYTES)
        val reparsed = RuntimeWireEnvelopeParser.parseCanonical(
            canonicalBytes = canonicalJson,
            declaredMessageType = envelope.messageType,
            declaredMessageId = envelope.messageId,
            declaredSenderSeq = envelope.senderSeq,
            expectedSenderRole = "ANDROID_CONTROLLER",
        )
        require(reparsed == envelope) { "controller envelope differs from canonical payload" }
        val sha = sha256Hex(canonicalJson)
        if (canonicalJson.size <= RuntimePolicy.INLINE_CANONICAL_MAX_BYTES) {
            channel.submitInline(
                envelope.messageType,
                envelope.messageId,
                envelope.senderSeq,
                canonicalJson.copyOf(),
                sha,
            )
        } else {
            sendBulk(envelope, canonicalJson.copyOf(), sha)
        }
    }

    private fun sendBulk(envelope: RuntimeWireEnvelope, bytes: ByteArray, sha: String) {
        val lease = bulkBudget.reserve(bytes.size)
        val pipe = try {
            ParcelFileDescriptor.createPipe()
        } catch (error: Throwable) {
            lease.close()
            throw error
        }
        require(pipe.size == 2)
        val readEnd = pipe[0]
        val writeEnd = pipe[1]
        activeWriteEnds += writeEnd
        try {
            writerExecutor.execute {
                try {
                    ParcelFileDescriptor.AutoCloseOutputStream(writeEnd).use { output ->
                        output.write(bytes)
                        output.flush()
                    }
                } catch (error: Throwable) {
                    if (!closed.get()) {
                        onFatalFailure(
                            "CONTROLLER_BULK_EGRESS_WRITE_FAILED: " +
                                (error.message ?: error::class.java.simpleName),
                        )
                    }
                } finally {
                    activeWriteEnds.remove(writeEnd)
                    closeQuietly(writeEnd)
                    lease.close()
                }
            }
        } catch (error: RejectedExecutionException) {
            activeWriteEnds.remove(writeEnd)
            lease.close()
            closeQuietly(readEnd)
            closeQuietly(writeEnd)
            throw error
        }

        try {
            channel.submitBulk(
                envelope.messageType,
                envelope.messageId,
                envelope.senderSeq,
                readEnd,
                bytes.size.toLong(),
                sha,
            )
        } catch (error: Throwable) {
            closeQuietly(writeEnd)
            throw error
        } finally {
            closeQuietly(readEnd)
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        activeWriteEnds.toList().forEach {
            closeQuietly(it)
            activeWriteEnds.remove(it)
        }
        writerExecutor.shutdownNow()
    }

    internal fun activeBulkWritesForTest(): Int = activeWriteEnds.size

    private fun closeQuietly(fd: ParcelFileDescriptor) {
        try { fd.close() } catch (_: Throwable) { }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
