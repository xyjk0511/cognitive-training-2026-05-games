package com.a620.tablet.training

interface RuntimeMessageSink {
    fun onCanonicalMessage(messageId: String, senderSeq: Long, canonicalJson: ByteArray)
    fun onControllerChannelClosed(reason: String)
}

class RejectingPlaceholderSink : RuntimeMessageSink {
    override fun onCanonicalMessage(messageId: String, senderSeq: Long, canonicalJson: ByteArray) {
        // Gate A/B scaffold only. Production wiring must invoke the generated
        // schema/state/semantic validators before reducer mutation.
        require(messageId.isNotBlank())
        require(senderSeq >= 1)
        require(canonicalJson.isNotEmpty())
    }

    override fun onControllerChannelClosed(reason: String) {
        require(reason.isNotBlank())
    }
}
