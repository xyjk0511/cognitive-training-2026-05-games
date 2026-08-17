package com.a620.tablet.training

import a620.RuntimeWireEnvelope

interface RuntimeMessageSink {
    /** Called only after hash, strict canonical JSON and common envelope checks. */
    fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray)
    fun onProtocolViolation(messageId: String?, reason: String)
    fun onTelemetryDropped(messageId: String, messageType: String)
    fun onFatalInfrastructureFailure(reason: String)
    fun onControllerChannelClosed(reason: String)
}

class RejectingPlaceholderSink : RuntimeMessageSink {
    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        // Gate A/B scaffold only. Production wiring must next run the generated
        // per-message schema, state and semantic validators in one reducer transaction.
        require(envelope.messageId.isNotBlank())
        require(envelope.senderSeq >= 1)
        require(canonicalJson.isNotEmpty())
    }

    override fun onProtocolViolation(messageId: String?, reason: String) {
        require(reason.isNotBlank())
    }

    override fun onTelemetryDropped(messageId: String, messageType: String) {
        require(messageId.isNotBlank())
        require(messageType in setOf("HEARTBEAT", "STATE_SNAPSHOT"))
    }

    override fun onFatalInfrastructureFailure(reason: String) {
        require(reason.isNotBlank())
    }

    override fun onControllerChannelClosed(reason: String) {
        require(reason.isNotBlank())
    }
}
