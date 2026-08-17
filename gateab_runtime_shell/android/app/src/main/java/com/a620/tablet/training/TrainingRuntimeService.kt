package com.a620.tablet.training

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.ParcelFileDescriptor
import a620.RuntimeIngressPriority
import java.security.MessageDigest
import java.util.concurrent.RejectedExecutionException

class TrainingRuntimeService : Service() {
    private val sink = StrictRuntimeMessageSink()
    private val actor = TrainingRuntimeActor { error ->
        sink.onFatalInfrastructureFailure("RUNTIME_ACTOR_FAILURE: ${error.message ?: error::class.java.simpleName}")
    }
    private val callbackLock = Any()

    @Volatile private var callback: ITrainingRuntimeCallback? = null
    @Volatile private var callbackBinder: IBinder? = null
    @Volatile private var callbackDeathRecipient: IBinder.DeathRecipient? = null
    @Volatile private var channelTokenForCallback: String? = null // transient; never persisted
    @Volatile private var channelTokenDigest: ByteArray? = null
    @Volatile private var channelGeneration: Long = 0

    private val ingress = CanonicalIngressCoordinator(
        expectedSenderRole = "ANDROID_CONTROLLER",
        actor = actor,
        sink = sink,
        isLiveChannel = ::isLiveChannel,
    )
    internal val eventTransport = RuntimeEventTransport(
        channelProvider = ::currentCallbackChannel,
        onFatalFailure = sink::onFatalInfrastructureFailure,
    )

    private val binder = object : ITrainingRuntime.Stub() {
        override fun registerCallback(
            newCallback: ITrainingRuntimeCallback,
            channelToken: String,
            generation: Long,
        ) {
            enforceSameUid()
            ChannelAuthenticator.requireValidToken(channelToken)
            require(generation > 0) { "channel generation must be positive" }
            val newDigest = ChannelAuthenticator.digest(channelToken)
            val newBinder = newCallback.asBinder()
            synchronized(callbackLock) {
                val oldDigest = channelTokenDigest
                val sameTokenEpoch = oldDigest != null && MessageDigest.isEqual(newDigest, oldDigest)
                if (sameTokenEpoch) {
                    require(generation > channelGeneration) { "generation must increase within one token epoch" }
                }

                val recipient = IBinder.DeathRecipient {
                    try {
                        actor.submitUrgent {
                            synchronized(callbackLock) {
                                // Delayed death from an old callback/token cannot close a newer channel.
                                if (channelGeneration == generation &&
                                    callbackBinder === newBinder &&
                                    MessageDigest.isEqual(channelTokenDigest, newDigest)
                                ) {
                                    clearCallbackLocked()
                                    sink.onControllerChannelClosed("CONTROLLER_BINDER_DIED")
                                }
                            }
                        }
                    } catch (_: RejectedExecutionException) {
                        sink.onFatalInfrastructureFailure("URGENT_LANE_UNAVAILABLE_ON_BINDER_DEATH")
                    }
                }

                // Link before replacing the old callback. A failed link leaves the
                // previously live channel intact.
                newBinder.linkToDeath(recipient, 0)
                callbackDeathRecipient?.let { oldRecipient ->
                    callbackBinder?.unlinkToDeath(oldRecipient, 0)
                }
                callback = newCallback
                callbackBinder = newBinder
                callbackDeathRecipient = recipient
                channelTokenForCallback = channelToken
                channelTokenDigest?.fill(0)
                channelTokenDigest = newDigest
                channelGeneration = generation
            }
        }

        override fun submitInline(
            messageType: String,
            messageId: String,
            senderSeq: Long,
            canonicalJson: ByteArray,
            canonicalSha256: String,
            channelToken: String,
            generation: Long,
        ) {
            enforceSameUid()
            requireLiveChannelOrReject(messageId, generation, channelToken)
            ingress.submitInline(
                messageType,
                messageId,
                senderSeq,
                canonicalJson,
                canonicalSha256,
                generation,
                channelToken,
            )
        }

        override fun submitBulk(
            messageType: String,
            messageId: String,
            senderSeq: Long,
            payloadFd: ParcelFileDescriptor,
            byteLength: Long,
            canonicalSha256: String,
            channelToken: String,
            generation: Long,
        ) {
            enforceSameUid()
            payloadFd.use { inbound ->
                requireLiveChannelOrReject(messageId, generation, channelToken)
                ingress.submitBulk(
                    messageType,
                    messageId,
                    senderSeq,
                    inbound,
                    byteLength,
                    canonicalSha256,
                    generation,
                    channelToken,
                )
            }
        }

        override fun closeChannel(channelToken: String, generation: Long, reason: String) {
            enforceSameUid()
            require(reason.isNotBlank())
            requireLiveChannelOrReject(null, generation, channelToken)
            actor.submit(RuntimeIngressPriority.URGENT, 1) {
                if (!isLiveChannel(generation, channelToken)) {
                    sink.onStaleChannelMessage(null, "STALE_CLOSE_CHANNEL")
                    return@submit
                }
                synchronized(callbackLock) {
                    sink.onControllerChannelClosed(reason)
                    clearCallbackLocked()
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        synchronized(callbackLock) { clearCallbackLocked() }
        ingress.close()
        eventTransport.close()
        actor.shutdownNow()
        super.onDestroy()
    }

    /** Snapshot used only by the internal Cocos-to-controller event transport. */
    internal fun currentCallbackChannel(): CallbackChannel? = synchronized(callbackLock) {
        val currentCallback = callback ?: return@synchronized null
        val token = channelTokenForCallback ?: return@synchronized null
        CallbackChannel(currentCallback, token, channelGeneration)
    }

    internal data class CallbackChannel(
        val callback: ITrainingRuntimeCallback,
        val token: String,
        val generation: Long,
    )

    private fun clearCallbackLocked() {
        callbackDeathRecipient?.let { callbackBinder?.unlinkToDeath(it, 0) }
        callback = null
        callbackBinder = null
        callbackDeathRecipient = null
        channelTokenForCallback = null
        channelTokenDigest?.fill(0)
        channelTokenDigest = null
        channelGeneration = 0
    }

    private fun requireLiveChannelOrReject(messageId: String?, generation: Long, token: String) {
        if (isLiveChannel(generation, token)) return
        sink.onStaleChannelMessage(messageId, "STALE_OR_UNAUTHENTICATED_AIDL_CHANNEL")
        throw SecurityException("stale or unauthenticated channel")
    }

    private fun enforceSameUid() {
        if (Binder.getCallingUid() != applicationInfo.uid) {
            throw SecurityException("cross-UID caller rejected")
        }
    }

    private fun isLiveChannel(generation: Long, token: String): Boolean =
        generation == channelGeneration &&
            callback != null &&
            ChannelAuthenticator.matches(token, channelTokenDigest)
}
