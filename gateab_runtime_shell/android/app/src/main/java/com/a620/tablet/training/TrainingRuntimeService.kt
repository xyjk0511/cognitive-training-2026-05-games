package com.a620.tablet.training

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.RejectedExecutionException

class TrainingRuntimeService : Service() {
    private val actor = TrainingRuntimeActor()
    private val sink: RuntimeMessageSink = RejectingPlaceholderSink()
    private val callbackLock = Any()

    @Volatile private var callback: ITrainingRuntimeCallback? = null
    @Volatile private var callbackBinder: IBinder? = null
    @Volatile private var callbackDeathRecipient: IBinder.DeathRecipient? = null
    @Volatile private var channelGeneration: Long = 0

    private val binder = object : ITrainingRuntime.Stub() {
        override fun registerCallback(newCallback: ITrainingRuntimeCallback, generation: Long) {
            enforceSameUid()
            require(generation > 0) { "channel generation must be positive" }
            val newBinder = newCallback.asBinder()
            synchronized(callbackLock) {
                require(generation > channelGeneration) { "channel generation must increase" }
                callbackDeathRecipient?.let { oldRecipient ->
                    callbackBinder?.unlinkToDeath(oldRecipient, 0)
                }
                lateinit var recipient: IBinder.DeathRecipient
                recipient = IBinder.DeathRecipient {
                    try {
                        actor.submit(1) {
                            synchronized(callbackLock) {
                                // A death from an old callback must not close a newer channel.
                                if (channelGeneration == generation && callbackBinder === newBinder) {
                                    callback = null
                                    callbackBinder = null
                                    callbackDeathRecipient = null
                                    sink.onControllerChannelClosed("CONTROLLER_BINDER_DIED")
                                }
                            }
                        }
                    } catch (_: RejectedExecutionException) {
                        // Actor saturation is itself fatal to this channel.  The
                        // controller-side Binder death/watchdog path must end the attempt.
                    }
                }
                newBinder.linkToDeath(recipient, 0)
                callback = newCallback
                callbackBinder = newBinder
                callbackDeathRecipient = recipient
                channelGeneration = generation
            }
        }

        override fun submitInline(
            messageId: String,
            senderSeq: Long,
            canonicalJson: ByteArray,
            canonicalSha256: String,
            generation: Long,
        ) {
            enforceSameUid()
            requireLiveGeneration(generation)
            require(messageId.isNotBlank())
            require(senderSeq >= 1)
            require(canonicalSha256.matches(Regex("[0-9a-f]{64}")))
            require(canonicalJson.size in 1..RuntimePolicy.INLINE_CANONICAL_MAX_BYTES)
            val ownedBytes = canonicalJson.copyOf()
            actor.submit(ownedBytes.size) {
                // Recheck after queueing: a newer generation may have replaced
                // this channel while the Binder call was waiting in the actor.
                requireLiveGeneration(generation)
                require(sha256Hex(ownedBytes) == canonicalSha256) { "inline hash mismatch" }
                sink.onCanonicalMessage(messageId, senderSeq, ownedBytes)
            }
        }

        override fun submitBulk(
            messageId: String,
            senderSeq: Long,
            payloadFd: ParcelFileDescriptor,
            byteLength: Long,
            canonicalSha256: String,
            generation: Long,
        ) {
            enforceSameUid()
            requireLiveGeneration(generation)
            require(messageId.isNotBlank())
            require(senderSeq >= 1)
            require(canonicalSha256.matches(Regex("[0-9a-f]{64}")))
            require(byteLength in 1..RuntimePolicy.BULK_CANONICAL_MAX_BYTES.toLong())
            // Binder owns the incoming object only for the call. Duplicate it
            // before queuing asynchronous work.
            val ownedFd = ParcelFileDescriptor.dup(payloadFd.fileDescriptor)
            try {
                actor.submit(byteLength.toInt()) {
                    ownedFd.use {
                        requireLiveGeneration(generation)
                        val bytes = readLimited(it, byteLength.toInt())
                        require(sha256Hex(bytes) == canonicalSha256) { "bulk hash mismatch" }
                        sink.onCanonicalMessage(messageId, senderSeq, bytes)
                    }
                }
            } catch (error: RejectedExecutionException) {
                ownedFd.close()
                throw error
            }
        }

        override fun closeChannel(generation: Long, reason: String) {
            enforceSameUid()
            require(reason.isNotBlank())
            requireLiveGeneration(generation)
            actor.submit(1) {
                requireLiveGeneration(generation)
                sink.onControllerChannelClosed(reason)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        synchronized(callbackLock) {
            callbackDeathRecipient?.let { callbackBinder?.unlinkToDeath(it, 0) }
            callback = null
            callbackBinder = null
            callbackDeathRecipient = null
        }
        actor.shutdownNow()
        super.onDestroy()
    }

    private fun enforceSameUid() {
        if (Binder.getCallingUid() != applicationInfo.uid) {
            throw SecurityException("cross-UID caller rejected")
        }
    }

    private fun requireLiveGeneration(generation: Long) {
        require(generation == channelGeneration && callback != null) {
            "stale or unregistered channel"
        }
    }

    private fun readLimited(fd: ParcelFileDescriptor, declaredLength: Int): ByteArray {
        FileInputStream(fd.fileDescriptor).use { input ->
            val output = ByteArrayOutputStream(declaredLength)
            val buffer = ByteArray(16 * 1024)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                require(total <= RuntimePolicy.BULK_CANONICAL_MAX_BYTES) { "bulk payload exceeds limit" }
                output.write(buffer, 0, count)
            }
            require(total == declaredLength) { "bulk length mismatch" }
            return output.toByteArray()
        }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
