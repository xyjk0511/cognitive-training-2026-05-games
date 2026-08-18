package com.a620.tablet.training

import android.os.SystemClock
import a620.CanonicalJson
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

fun interface CanonicalControllerSender {
    fun send(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray)
}

/**
 * Builds and commits ACK_RESULT_COMMITTED only after the durable result
 * transaction succeeds. Replayed RESULT_READY events resend the exact first
 * ACK bytes instead of creating new commit facts.
 */
class ControllerResultCommitCoordinator(
    private val store: AndroidControllerStore,
    private val outboxDispatcher: ControllerOutboxDispatcher,
) {
    /**
     * Handles the application-level retry loop for a lost oneway Binder ACK.
     * Exact RESULT_READY replay reopens the original ACK row and never creates
     * new result, timestamp, messageId or senderSeq facts.
     */
    fun replayCommittedAckIfPresent(
        resultReady: RuntimeWireEnvelope,
        canonicalResultReady: ByteArray,
    ): FormalCommitReceipt? {
        val stored = store.requeueCommittedAckForExactResultReplay(
            resultReady,
            canonicalResultReady,
            System.currentTimeMillis(),
        ) ?: return null
        outboxDispatcher.scheduleDrain()
        return stored.receipt
    }

    fun commitAndSend(resultReady: RuntimeWireEnvelope, canonicalResultReady: ByteArray): FormalCommitReceipt {
        replayCommittedAckIfPresent(resultReady, canonicalResultReady)?.let { return it }

        val committedAtUtcMs = System.currentTimeMillis()
        val committedAtUptimeMs = SystemClock.uptimeMillis()
        val resultHash = resultReady.payload["resultDraftSha256"] as? String
            ?: throw AndroidStoreConflict("RESULT_READY.resultDraftSha256 missing")
        val resultId = stableId("RES", resultReady.runtimeSessionId, resultReady.messageId)
        val ackMessageId = stableId("ACK", resultReady.runtimeSessionId, resultReady.messageId)
        val senderSeq = store.reserveNextControllerSenderSeq(resultReady.runtimeSessionId)
        val ackValue = linkedMapOf<String, Any?>(
            "contractVersion" to resultReady.contractVersion,
            "messageType" to "ACK_RESULT_COMMITTED",
            "messageId" to ackMessageId,
            "correlationId" to resultReady.messageId,
            "senderRole" to "ANDROID_CONTROLLER",
            "senderSeq" to senderSeq,
            "sentAtUtc" to Instant.ofEpochMilli(committedAtUtcMs).toString(),
            "sentAtUptimeMs" to committedAtUptimeMs,
            "monotonicEpochId" to resultReady.monotonicEpochId,
            "systemId" to resultReady.systemId,
            "deviceId" to resultReady.deviceId,
            "taskId" to resultReady.taskId,
            "taskItemId" to resultReady.taskItemId,
            "executionAttempt" to resultReady.executionAttempt,
            "runtimeSessionId" to resultReady.runtimeSessionId,
            "packageVersion" to resultReady.packageVersion,
            "coreProtocolVersion" to resultReady.coreProtocolVersion,
            "payload" to linkedMapOf<String, Any?>(
                "resultId" to resultId,
                "resultPayloadSha256" to resultHash,
                "committedAtUtc" to Instant.ofEpochMilli(committedAtUtcMs).toString(),
                "committedAtUptimeMs" to committedAtUptimeMs,
            ),
        )
        val canonicalAck = CanonicalJson.canonicalBytes(ackValue)
        val ackEnvelope = RuntimeWireEnvelopeParser.parseCanonical(
            canonicalBytes = canonicalAck,
            expectedSenderRole = "ANDROID_CONTROLLER",
        )
        val receipt = store.commitFormalResult(
            resultReady = resultReady,
            canonicalResultReady = canonicalResultReady,
            resultId = resultId,
            ackEnvelope = ackEnvelope,
            canonicalAck = canonicalAck,
            committedAtUtcMs = committedAtUtcMs,
            committedAtUptimeMs = committedAtUptimeMs,
        )
        if (receipt.idempotentReplay) {
            val stored = requireNotNull(store.loadCommittedAck(resultReady, canonicalResultReady)) {
                "committed result is missing its durable ACK"
            }
            outboxDispatcher.scheduleDrain()
            return stored.receipt
        }
        outboxDispatcher.scheduleDrain()
        return receipt
    }

    private fun stableId(prefix: String, runtimeSessionId: String, resultReadyMessageId: String): String {
        val material = "$prefix|$runtimeSessionId|$resultReadyMessageId".toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(material)
            .joinToString("") { "%02x".format(it) }
        return "$prefix-${digest.take(32)}"
    }
}

/**
 * Controller callback sink that persists every authoritative Cocos event before
 * applying result semantics. Telemetry may be dropped only by the ingress
 * policy; protocol and infrastructure failures terminate the current attempt.
 */
class DurableControllerEventSink(
    private val store: AndroidControllerStore,
    private val runtimeSessionId: String,
    private val executionAttempt: Long,
    private val onPersistedEvent: (RuntimeWireEnvelope) -> Unit = {},
) : RuntimeMessageSink {
    private val interrupted = AtomicBoolean(false)
    @Volatile private var resultCoordinator: ControllerResultCommitCoordinator? = null

    fun attachResultCoordinator(value: ControllerResultCommitCoordinator) {
        check(resultCoordinator == null) { "result coordinator already attached" }
        resultCoordinator = value
    }

    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        require(envelope.runtimeSessionId == runtimeSessionId && envelope.executionAttempt == executionAttempt)
        val coordinator = if (envelope.messageType == "RESULT_READY") {
            requireNotNull(resultCoordinator) { "result coordinator not attached" }
        } else null

        // A result retry must be checked before the generic terminal-runtime
        // late-audit path. Otherwise a lost ACK would strand Cocos forever after
        // Android had already committed and terminalized the formal result.
        coordinator?.replayCommittedAckIfPresent(envelope, canonicalJson)?.let { return }

        val disposition = store.persistRuntimeEvent(envelope, canonicalJson, SystemClock.uptimeMillis())
        if (disposition == EventPersistenceDisposition.LATE_AUDIT) return
        coordinator?.commitAndSend(envelope, canonicalJson)
        onPersistedEvent(envelope)
    }

    override fun onProtocolViolation(messageId: String?, reason: String) {
        interruptOnce("PROTOCOL_VIOLATION:${messageId ?: "UNKNOWN"}:$reason")
    }

    override fun onTelemetryDropped(messageId: String, messageType: String) {
        require(messageType in RuntimePolicy.DROPPABLE_ON_BACKPRESSURE_MESSAGE_TYPES)
        require(messageId.isNotBlank())
        store.recordTransportAudit(
            runtimeSessionId,
            messageId,
            "TELEMETRY_DROPPED",
            messageType,
            SystemClock.uptimeMillis(),
        )
    }

    override fun onStaleChannelMessage(messageId: String?, reason: String) {
        // A stale channel is expected during rebinding. It is durably audited
        // but cannot mutate the current runtime or create a formal result.
        require(reason.isNotBlank())
        store.recordTransportAudit(
            runtimeSessionId,
            messageId,
            "STALE_CHANNEL",
            reason,
            SystemClock.uptimeMillis(),
        )
    }

    override fun onFatalInfrastructureFailure(reason: String) {
        interruptOnce("INFRASTRUCTURE_FAILURE:$reason")
    }

    override fun onControllerChannelClosed(reason: String) {
        interruptOnce("CONTROLLER_CHANNEL_CLOSED:$reason")
    }

    private fun interruptOnce(reason: String) {
        if (!interrupted.compareAndSet(false, true)) return
        val observedAt = SystemClock.uptimeMillis()
        try {
            store.recordInterrupted(runtimeSessionId, executionAttempt, reason.take(256), observedAt)
        } catch (conflict: AndroidStoreConflict) {
            // A formal result may already be durably committed when ACK transport
            // later fails. Never rewrite COMPLETE into INTERRUPTED; preserve the
            // result and record the infrastructure failure for maintenance.
            runCatching {
                store.recordTransportAudit(
                    runtimeSessionId,
                    null,
                    "INFRASTRUCTURE_FAILURE",
                    reason.take(256),
                    observedAt,
                )
            }
        }
    }
}
