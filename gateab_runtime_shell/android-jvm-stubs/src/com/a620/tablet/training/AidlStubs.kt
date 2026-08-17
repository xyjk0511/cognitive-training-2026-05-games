package com.a620.tablet.training

import android.os.Binder
import android.os.IBinder
import android.os.ParcelFileDescriptor

interface ITrainingRuntime {
    fun registerCallback(newCallback: ITrainingRuntimeCallback, channelToken: String, generation: Long)
    fun submitInline(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, generation: Long)
    fun submitBulk(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, generation: Long)
    fun closeChannel(channelToken: String, generation: Long, reason: String)

    abstract class Stub : Binder(), ITrainingRuntime {
        companion object { fun asInterface(service: IBinder): ITrainingRuntime = service as ITrainingRuntime }
    }
}

interface ITrainingRuntimeCallback {
    fun onInlineEvent(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, channelGeneration: Long)
    fun onBulkEvent(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, channelGeneration: Long)
    fun onRuntimeInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long, channelToken: String, channelGeneration: Long)
    fun asBinder(): IBinder

    abstract class Stub : Binder(), ITrainingRuntimeCallback {
        override fun asBinder(): IBinder = this
    }
}
