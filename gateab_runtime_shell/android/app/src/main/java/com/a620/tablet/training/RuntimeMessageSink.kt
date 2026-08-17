package com.a620.tablet.training

import a620.RuntimeWireEnvelope
import java.security.MessageDigest

interface RuntimeMessageSink {
    /** Called only after hash, strict canonical JSON and common envelope checks. */
    fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray)
    fun onProtocolViolation(messageId: String?, reason: String)
    fun onTelemetryDropped(messageId: String, messageType: String)
    fun onStaleChannelMessage(messageId: String?, reason: String)
    fun onFatalInfrastructureFailure(reason: String)
    fun onControllerChannelClosed(reason: String)
}

data class RuntimeIdentityFingerprint(
    val systemId: String,
    val deviceId: String,
    val taskId: String,
    val taskItemId: String,
    val executionAttempt: Long,
    val runtimeSessionId: String,
    val monotonicEpochId: String,
    val packageVersion: String,
    val coreProtocolVersion: String,
) {
    companion object {
        fun from(envelope: RuntimeWireEnvelope) = RuntimeIdentityFingerprint(
            envelope.systemId,
            envelope.deviceId,
            envelope.taskId,
            envelope.taskItemId,
            envelope.executionAttempt,
            envelope.runtimeSessionId,
            envelope.monotonicEpochId,
            envelope.packageVersion,
            envelope.coreProtocolVersion,
        )
    }
}

/**
 * Fail-closed ingress ledger used by the Android shell until the game-specific
 * reducer is attached.  Unlike the old placeholder, this enforces one runtime
 * identity, per-sender monotonic cursors and exact message-id idempotency.
 *
 * This class deliberately does not claim durable formal-result semantics; the
 * controller database remains the authority for BATCH_CLOSED reconciliation
 * and RESULT_READY commit.
 */
class StrictRuntimeMessageSink(
    private val onFirstAccepted: (RuntimeWireEnvelope, ByteArray) -> Unit = { _, _ -> },
    private val onAccepted: (RuntimeWireEnvelope, ByteArray, Boolean) -> Unit = { _, _, _ -> },
    private val onTerminal: (String) -> Unit = {},
) : RuntimeMessageSink {
    private val lock = Any()
    private var identity: RuntimeIdentityFingerprint? = null
    private val messageHashById = LinkedHashMap<String, String>()
    private val senderSeqCursor = HashMap<String, Long>()
    private val senderUptimeCursor = HashMap<String, Long>()
    private var terminalReason: String? = null
    private var acceptedMessages: Long = 0
    private var replayedMessages: Long = 0
    private var droppedTelemetry: Long = 0
    private var staleChannelMessages: Long = 0

    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        val canonicalHash = sha256Hex(canonicalJson)
        var first = false
        var replay = false
        synchronized(lock) {
            check(terminalReason == null) { "runtime ingress is terminal: $terminalReason" }
            val incomingIdentity = RuntimeIdentityFingerprint.from(envelope)
            if (identity == null) {
                identity = incomingIdentity
                first = true
            } else {
                require(identity == incomingIdentity) { "runtime identity changed within one channel" }
            }

            val oldHash = messageHashById[envelope.messageId]
            if (oldHash != null) {
                require(MessageDigest.isEqual(oldHash.hexBytes(), canonicalHash.hexBytes())) {
                    "messageId replay has different canonical content"
                }
                replay = true
                replayedMessages += 1
            } else {
                val oldSeq = senderSeqCursor[envelope.senderRole] ?: 0L
                require(envelope.senderSeq > oldSeq) { "senderSeq must strictly increase for first-seen messages" }
                val oldUptime = senderUptimeCursor[envelope.senderRole] ?: 0L
                require(envelope.sentAtUptimeMs >= oldUptime) { "sender uptime regressed within one monotonic epoch" }
                senderSeqCursor[envelope.senderRole] = envelope.senderSeq
                senderUptimeCursor[envelope.senderRole] = envelope.sentAtUptimeMs
                messageHashById[envelope.messageId] = canonicalHash
                acceptedMessages += 1
            }
        }
        if (first) onFirstAccepted(envelope, canonicalJson.copyOf())
        onAccepted(envelope, canonicalJson.copyOf(), replay)
    }

    override fun onProtocolViolation(messageId: String?, reason: String) = terminate(
        "PROTOCOL_VIOLATION:${messageId ?: "UNKNOWN"}:${reason.ifBlank { "UNSPECIFIED" }}",
    )

    override fun onTelemetryDropped(messageId: String, messageType: String) {
        require(messageId.isNotBlank())
        require(messageType in RuntimePolicy.DROPPABLE_ON_BACKPRESSURE_MESSAGE_TYPES)
        synchronized(lock) { droppedTelemetry += 1 }
    }

    override fun onStaleChannelMessage(messageId: String?, reason: String) {
        require(reason.isNotBlank())
        synchronized(lock) { staleChannelMessages += 1 }
    }

    override fun onFatalInfrastructureFailure(reason: String) = terminate(
        "INFRASTRUCTURE_FAILURE:${reason.ifBlank { "UNSPECIFIED" }}",
    )

    override fun onControllerChannelClosed(reason: String) = terminate(
        "CONTROLLER_CHANNEL_CLOSED:${reason.ifBlank { "UNSPECIFIED" }}",
    )

    fun snapshot(): StrictIngressSnapshot = synchronized(lock) {
        StrictIngressSnapshot(
            identity = identity,
            acceptedMessages = acceptedMessages,
            replayedMessages = replayedMessages,
            droppedTelemetry = droppedTelemetry,
            staleChannelMessages = staleChannelMessages,
            terminalReason = terminalReason,
            senderSeqCursor = senderSeqCursor.toMap(),
            messageCount = messageHashById.size,
        )
    }

    private fun terminate(reason: String) {
        var notify = false
        synchronized(lock) {
            if (terminalReason == null) {
                terminalReason = reason
                notify = true
            }
        }
        if (notify) onTerminal(reason)
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun String.hexBytes(): ByteArray {
        require(length % 2 == 0)
        return ByteArray(length / 2) { index -> substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }
}

data class StrictIngressSnapshot(
    val identity: RuntimeIdentityFingerprint?,
    val acceptedMessages: Long,
    val replayedMessages: Long,
    val droppedTelemetry: Long,
    val staleChannelMessages: Long,
    val terminalReason: String?,
    val senderSeqCursor: Map<String, Long>,
    val messageCount: Int,
)
