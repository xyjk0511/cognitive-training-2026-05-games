package com.a620.tablet.training

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.ParcelFileDescriptor
import a620.RuntimeIngressPriority
import java.util.concurrent.RejectedExecutionException

class TrainingRuntimeService : Service() {
    private val sink: RuntimeMessageSink = RejectingPlaceholderSink()
    private val actor = TrainingRuntimeActor { error ->
        sink.onFatalInfrastructureFailure("RUNTIME_ACTOR_FAILURE: ${error.message ?: error::class.java.simpleName}")
    }
    private val callbackLock = Any()

    @Volatile private var callback: ITrainingRuntimeCallback? = null
    @Volatile private var callbackBinder: IBinder? = null
    @Volatile private var callbackDeathRecipient: IBinder.DeathRecipient? = null
    @Volatile private var channelGeneration: Long = 0

    private val ingress = CanonicalIngressCoordinator(
        expectedSenderRole = "ANDROID_CONTROLLER",
        actor = actor,
        sink = sink,
        requireLiveGeneration = ::requireLiveGeneration,
    )

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
                val recipient = IBinder.DeathRecipient {
                    try {
                        actor.submitUrgent {
                            synchronized(callbackLock) {
                                // A delayed death from an old callback cannot close a newer channel.
                                if (channelGeneration == generation && callbackBinder === newBinder) {
                                    callback = null
                                    callbackBinder = null
                                    callbackDeathRecipient = null
                                    sink.onControllerChannelClosed("CONTROLLER_BINDER_DIED")
                                }
                            }
                        }
                    } catch (_: RejectedExecutionException) {
                        sink.onFatalInfrastructureFailure("URGENT_LANE_UNAVAILABLE_ON_BINDER_DEATH")
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
            messageType: String,
            messageId: String,
            senderSeq: Long,
            canonicalJson: ByteArray,
            canonicalSha256: String,
            generation: Long,
        ) {
            enforceSameUid()
            ingress.submitInline(
                messageType,
                messageId,
                senderSeq,
                canonicalJson,
                canonicalSha256,
                generation,
            )
        }

        override fun submitBulk(
            messageType: String,
            messageId: String,
            senderSeq: Long,
            payloadFd: ParcelFileDescriptor,
            byteLength: Long,
            canonicalSha256: String,
            generation: Long,
        ) {
            enforceSameUid()
            ingress.submitBulk(
                messageType,
                messageId,
                senderSeq,
                payloadFd,
                byteLength,
                canonicalSha256,
                generation,
            )
        }

        override fun closeChannel(generation: Long, reason: String) {
            enforceSameUid()
            require(reason.isNotBlank())
            requireLiveGeneration(generation)
            actor.submit(RuntimeIngressPriority.URGENT, 1) {
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
        ingress.close()
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
}
