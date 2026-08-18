package com.a620.tablet.training

import android.os.SystemClock
import a620.CanonicalJson
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

internal enum class DeviceMockState {
    UNPREPARED, READY, RUNNING, PAUSED, FINALIZING,
    RESULT_READY, RESULT_COMMITTED, TERMINATED, INTERRUPTED,
}

internal data class DeviceMockBatch(
    val ordinal: Long,
    val payload: LinkedHashMap<String, Any?>,
)

internal data class DeviceMockDeadlineResult(
    val batches: List<DeviceMockBatch>,
    val gamePayload: LinkedHashMap<String, Any?>,
)

/**
 * Engine-independent Gate A/B fixture. It implements only the public common
 * lifecycle/result model and deliberately contains no production game rules.
 */
internal class DeviceShellMockGame(
    private val eligibleBatchTarget: Int = 8,
) {
    private lateinit var prepare: RuntimeWireEnvelope
    private var currentLevel = 1L
    private var state = DeviceMockState.UNPREPARED
    private val batches = mutableListOf<DeviceMockBatch>()
    private var cachedDeadlineResult: DeviceMockDeadlineResult? = null

    init { require(eligibleBatchTarget in setOf(0, 1, 7, 8)) }

    fun prepare(envelope: RuntimeWireEnvelope) {
        check(state == DeviceMockState.UNPREPARED)
        require(envelope.messageType == "PREPARE")
        require(envelope.payload.requiredLong("durationMs") == 300_000L)
        require(envelope.payload.requiredLong("plannedBatchCount") == 8L)
        currentLevel = envelope.payload.requiredLong("sessionStartLevel")
        prepare = envelope
        state = DeviceMockState.READY
    }

    fun start() { check(state == DeviceMockState.READY); state = DeviceMockState.RUNNING }
    fun pause() { check(state == DeviceMockState.RUNNING); state = DeviceMockState.PAUSED }
    fun resume() { check(state == DeviceMockState.PAUSED); state = DeviceMockState.RUNNING }

    fun deadline(): DeviceMockDeadlineResult {
        cachedDeadlineResult?.let { return it }
        check(state == DeviceMockState.RUNNING || state == DeviceMockState.PAUSED)
        state = DeviceMockState.FINALIZING
        repeat(eligibleBatchTarget) { index ->
            val ordinal = index.toLong() + 1L
            batches += DeviceMockBatch(ordinal, closeBatch(ordinal))
        }
        val result = DeviceMockDeadlineResult(batches.toList(), buildGamePayload())
        cachedDeadlineResult = result
        state = DeviceMockState.RESULT_READY
        return result
    }

    fun commit(resultPayloadSha256: String) {
        check(state == DeviceMockState.RESULT_READY || state == DeviceMockState.RESULT_COMMITTED)
        require(CanonicalJson.sha256(requireNotNull(cachedDeadlineResult).gamePayload) == resultPayloadSha256) {
            "ACK result hash differs from first RESULT_READY"
        }
        state = DeviceMockState.RESULT_COMMITTED
    }

    fun terminate() {
        check(state !in setOf(DeviceMockState.RESULT_COMMITTED, DeviceMockState.INTERRUPTED))
        state = DeviceMockState.TERMINATED
    }

    fun interrupt() {
        if (state !in setOf(DeviceMockState.RESULT_COMMITTED, DeviceMockState.TERMINATED)) {
            state = DeviceMockState.INTERRUPTED
        }
    }

    fun snapshotState(): DeviceMockState = state

    private fun closeBatch(ordinal: Long): LinkedHashMap<String, Any?> {
        val designMax = prepare.payload.requiredLong("designMaxLevel")
        val before = currentLevel
        val atMax = before >= designMax
        val after = if (atMax) before else before + 1L
        currentLevel = after
        val projection = linkedMapOf<String, Any?>(
            "batchOrdinal" to ordinal,
            "closed" to true,
            "decisionEligible" to true,
            "levelBefore" to before,
            "resultZone" to "UPGRADE",
            "levelTransition" to if (atMax) "HOLD_MAX" else "UP",
            "levelAfter" to after,
            "batchScore" to 80L + ordinal,
            "closedAtActiveMs" to 35_000L + (ordinal - 1L) * 37_500L,
            "gameBatchMetrics" to linkedMapOf<String, Any?>(),
        )
        return LinkedHashMap(projection).apply {
            put("batchPayloadSha256", CanonicalJson.sha256(projection))
        }
    }

    private fun buildGamePayload(): LinkedHashMap<String, Any?> {
        val planned = prepare.payload.requiredLong("plannedBatchCount")
        val start = prepare.payload.requiredLong("sessionStartLevel")
        val designMax = prepare.payload.requiredLong("designMaxLevel")
        val eligible = batches.map { LinkedHashMap(it.payload) }
        val incomplete: List<Map<String, Any?>> = if (batches.size < planned.toInt()) {
            val ordinal = batches.size.toLong() + 1L
            val previousClosedAt = batches.lastOrNull()?.payload?.get("closedAtActiveMs") as? Long ?: 0L
            listOf(
                linkedMapOf(
                    "batchOrdinal" to ordinal,
                    "levelBefore" to currentLevel,
                    "cutoffReason" to "DEADLINE",
                    "startedAtActiveMs" to maxOf(previousClosedAt, (ordinal - 1L) * 37_500L),
                    "cutoffAtActiveMs" to 300_000L,
                    "partialMetrics" to linkedMapOf<String, Any?>(),
                ),
            )
        } else {
            emptyList()
        }
        val highestPresented = maxOf(
            start,
            batches.maxOfOrNull { it.payload["levelBefore"] as Long } ?: start,
            if (incomplete.isNotEmpty()) currentLevel else start,
        )
        val highestPassed = batches
            .filter { it.payload["resultZone"] == "UPGRADE" }
            .maxOfOrNull { it.payload["levelBefore"] as Long }
        return linkedMapOf(
            "gameCode" to prepare.payload.requiredString("gameCode"),
            "gamePayloadVersion" to "A620-GP-1.1",
            "runtimeConfigHash" to prepare.payload.requiredSha256("runtimeConfigHash"),
            "designMaxLevel" to designMax,
            "plannedBatchCount" to planned,
            "eligibleBatchCount" to batches.size.toLong(),
            "eligibleBatches" to eligible,
            "incompleteBatchAudit" to incomplete,
            "sessionStartLevel" to start,
            "sessionEndLevel" to currentLevel,
            "sessionHighestPresentedLevel" to highestPresented,
            "sessionHighestPassedLevel" to highestPassed,
            "nextStartLevel" to currentLevel,
            "sessionRawScore" to batches.sumOf { it.payload["batchScore"] as Long },
            "sessionRawScoreMax" to planned * 100L,
            "actualTrainingMs" to 300_000L,
            "gameMetrics" to linkedMapOf<String, Any?>(),
        )
    }

    private fun Map<String, Any?>.requiredString(name: String): String =
        (this[name] as? String)?.also { require(it.isNotBlank()) } ?: error("$name must be string")

    private fun Map<String, Any?>.requiredSha256(name: String): String = requiredString(name).also {
        require(it.matches(Regex("^[0-9a-f]{64}$")))
    }

    private fun Map<String, Any?>.requiredLong(name: String): Long =
        (this[name] as? Long) ?: error("$name must be integer")
}

internal fun interface DeviceRuntimeEventSender {
    fun send(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray)
}

/** Converts canonical controller commands into the deterministic mock lifecycle. */
internal class DeviceShellMockRuntime(
    private val eventSender: DeviceRuntimeEventSender,
    private val interruptionSender: (RuntimeWireEnvelope?, String, Long) -> Unit,
    eligibleBatchTarget: Int = 8,
) : RuntimeMessageSink {
    private val mock = DeviceShellMockGame(eligibleBatchTarget)
    private val terminalNotified = AtomicBoolean(false)
    private var identity: RuntimeWireEnvelope? = null
    private var eventSeq = 0L
    private var lastEventUptimeMs = 0L
    private var lastAppliedControllerSeq = 0L
    private var activeElapsedMs = 0L
    private var clockRevision = 0L
    private var resultReadyBytes: ByteArray? = null
    private var resultReadyEnvelope: RuntimeWireEnvelope? = null
    private val strict = StrictRuntimeMessageSink(
        onFirstAccepted = { envelope, _ -> identity = envelope },
        onAccepted = ::handleAccepted,
        onTerminal = ::notifyInterrupted,
    )

    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) =
        strict.onCanonicalMessage(envelope, canonicalJson)
    override fun onProtocolViolation(messageId: String?, reason: String) = strict.onProtocolViolation(messageId, reason)
    override fun onTelemetryDropped(messageId: String, messageType: String) = strict.onTelemetryDropped(messageId, messageType)
    override fun onStaleChannelMessage(messageId: String?, reason: String) = strict.onStaleChannelMessage(messageId, reason)
    override fun onFatalInfrastructureFailure(reason: String) = strict.onFatalInfrastructureFailure(reason)
    override fun onControllerChannelClosed(reason: String) = strict.onControllerChannelClosed(reason)

    fun retryResultReadyForTest() {
        val envelope = requireNotNull(resultReadyEnvelope) { "RESULT_READY has not been produced" }
        eventSender.send(envelope, requireNotNull(resultReadyBytes).copyOf())
    }

    fun stateForTest(): DeviceMockState = mock.snapshotState()

    private fun handleAccepted(command: RuntimeWireEnvelope, canonicalJson: ByteArray, replay: Boolean) {
        if (replay) {
            if (command.messageType == "DEADLINE") retryResultReadyForTest()
            return
        }
        require(canonicalJson.isNotEmpty())
        lastAppliedControllerSeq = command.senderSeq
        command.payload["activeElapsedMs"]?.let { activeElapsedMs = it as Long }
        command.payload["clockRevision"]?.let { clockRevision = it as Long }
        when (command.messageType) {
            "PREPARE" -> {
                mock.prepare(command)
                emit("READY", command.messageId, linkedMapOf(
                    "runtimeConfigHash" to command.payload["runtimeConfigHash"],
                    "plannedBatchCount" to command.payload["plannedBatchCount"],
                    "runtimeState" to "READY",
                ))
            }
            "START" -> {
                mock.start()
                emitAccepted(command, "START_SCHEDULED", command.payload.getValue("effectiveStartUptimeMs"))
                emit("STARTED", command.messageId, linkedMapOf(
                    "effectiveStartUptimeMs" to command.payload["effectiveStartUptimeMs"],
                    "cutoffUptimeMs" to command.payload["cutoffUptimeMs"],
                    "runtimeState" to "RUNNING",
                    "clockRevision" to command.payload["clockRevision"],
                ))
            }
            "PAUSE" -> {
                mock.pause()
                emitAccepted(command, "PAUSE_SCHEDULED", command.payload.getValue("effectivePauseUptimeMs"))
                emit("PAUSED", command.messageId, linkedMapOf(
                    "effectivePauseUptimeMs" to command.payload["effectivePauseUptimeMs"],
                    "activeElapsedMs" to command.payload["activeElapsedMs"],
                    "runtimeState" to "PAUSED",
                    "clockRevision" to command.payload["clockRevision"],
                ))
            }
            "RESUME" -> {
                mock.resume()
                emitAccepted(command, "RESUME_SCHEDULED", command.payload.getValue("resumeInputEnabledUptimeMs"))
                emit("RESUMED", command.messageId, linkedMapOf(
                    "resumeInputEnabledUptimeMs" to command.payload["resumeInputEnabledUptimeMs"],
                    "cutoffUptimeMs" to command.payload["cutoffUptimeMs"],
                    "activeElapsedMs" to command.payload["activeElapsedMs"],
                    "runtimeState" to "RUNNING",
                    "clockRevision" to command.payload["clockRevision"],
                ))
            }
            "DEADLINE" -> {
                activeElapsedMs = 300_000L
                val result = mock.deadline()
                result.batches.forEach { emit("BATCH_CLOSED", command.messageId, it.payload) }
                val payload = linkedMapOf<String, Any?>(
                    "resultDraftSha256" to CanonicalJson.sha256(result.gamePayload),
                    "gamePayload" to result.gamePayload,
                )
                val pair = buildEvent("RESULT_READY", command.messageId, payload)
                resultReadyEnvelope = pair.first
                resultReadyBytes = pair.second.copyOf()
                eventSender.send(pair.first, pair.second)
            }
            "ACK_RESULT_COMMITTED" -> mock.commit(command.payload.requiredString("resultPayloadSha256"))
            "QUERY_STATE" -> emit("STATE_SNAPSHOT", command.messageId, linkedMapOf(
                "runtimeState" to wireState(),
                "activeElapsedMs" to activeElapsedMs,
                "clockRevision" to clockRevision,
                "lastAppliedControllerSeq" to lastAppliedControllerSeq,
            ))
            "TERMINATE" -> {
                val effective = command.payload.getValue("effectiveTerminateUptimeMs")
                emitAccepted(command, "TERMINATING", effective)
                mock.terminate()
                emit("TERMINATED", command.messageId, linkedMapOf(
                    "effectiveTerminateUptimeMs" to effective,
                    "runtimeState" to "TERMINATED",
                    "reasonCode" to command.payload["reasonCode"],
                ))
            }
            else -> error("unsupported controller command in device-shell mock: ${command.messageType}")
        }
    }

    private fun wireState(): String = when (mock.snapshotState()) {
        DeviceMockState.UNPREPARED -> "UNPREPARED"
        DeviceMockState.READY -> "READY"
        DeviceMockState.RUNNING -> "RUNNING"
        DeviceMockState.PAUSED -> "PAUSED"
        DeviceMockState.FINALIZING -> "FINALIZING"
        DeviceMockState.RESULT_READY -> "RESULT_PENDING_COMMIT"
        DeviceMockState.RESULT_COMMITTED -> "RESULT_COMMITTED"
        DeviceMockState.TERMINATED -> "TERMINATED"
        DeviceMockState.INTERRUPTED -> "ERROR"
    }

    private fun emitAccepted(command: RuntimeWireEnvelope, state: String, effectiveAt: Any?) =
        emit("COMMAND_ACCEPTED", command.messageId, linkedMapOf(
            "acceptedMessageType" to command.messageType,
            "effectiveAtUptimeMs" to effectiveAt,
            "runtimeState" to state,
            "clockRevision" to (command.payload["clockRevision"] ?: 1L),
        ))

    private fun emit(messageType: String, correlationId: String?, payload: Map<String, Any?>) {
        val pair = buildEvent(messageType, correlationId, payload)
        eventSender.send(pair.first, pair.second)
    }

    private fun buildEvent(
        messageType: String,
        correlationId: String?,
        payload: Map<String, Any?>,
    ): Pair<RuntimeWireEnvelope, ByteArray> {
        val base = requireNotNull(identity) { "PREPARE identity not established" }
        val uptime = maxOf(SystemClock.uptimeMillis(), lastEventUptimeMs + 1L)
        lastEventUptimeMs = uptime
        eventSeq += 1L
        val sessionDigest = MessageDigest.getInstance("SHA-256")
            .digest(base.runtimeSessionId.toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(16)
        val messageId = "MOCK-$sessionDigest-${eventSeq.toString().padStart(8, '0')}"
        val value = linkedMapOf<String, Any?>(
            "contractVersion" to base.contractVersion,
            "messageType" to messageType,
            "messageId" to messageId,
            "correlationId" to correlationId,
            "senderRole" to "COCOS_RUNTIME",
            "senderSeq" to eventSeq,
            "sentAtUtc" to Instant.now().toString(),
            "sentAtUptimeMs" to uptime,
            "monotonicEpochId" to base.monotonicEpochId,
            "systemId" to base.systemId,
            "deviceId" to base.deviceId,
            "taskId" to base.taskId,
            "taskItemId" to base.taskItemId,
            "executionAttempt" to base.executionAttempt,
            "runtimeSessionId" to base.runtimeSessionId,
            "packageVersion" to base.packageVersion,
            "coreProtocolVersion" to base.coreProtocolVersion,
            "payload" to LinkedHashMap(payload),
        )
        val bytes = CanonicalJson.canonicalBytes(value)
        return RuntimeWireEnvelopeParser.parseCanonical(
            canonicalBytes = bytes,
            expectedSenderRole = "COCOS_RUNTIME",
        ) to bytes
    }

    private fun notifyInterrupted(reason: String) {
        mock.interrupt()
        if (!terminalNotified.compareAndSet(false, true)) return
        interruptionSender(identity, reason.take(256), SystemClock.uptimeMillis())
    }

    private fun Map<String, Any?>.requiredString(name: String): String =
        (this[name] as? String)?.also { require(it.isNotBlank()) } ?: error("$name must be string")
}

/** Stable delegate captured by ingress while callback registration installs a fresh reducer. */
internal class SwitchableRuntimeMessageSink : RuntimeMessageSink {
    private val lock = Any()
    @Volatile private var delegate: RuntimeMessageSink = StrictRuntimeMessageSink()

    fun replace(next: RuntimeMessageSink): RuntimeMessageSink = synchronized(lock) {
        val previous = delegate
        delegate = next
        previous
    }

    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) = delegate.onCanonicalMessage(envelope, canonicalJson)
    override fun onProtocolViolation(messageId: String?, reason: String) = delegate.onProtocolViolation(messageId, reason)
    override fun onTelemetryDropped(messageId: String, messageType: String) = delegate.onTelemetryDropped(messageId, messageType)
    override fun onStaleChannelMessage(messageId: String?, reason: String) = delegate.onStaleChannelMessage(messageId, reason)
    override fun onFatalInfrastructureFailure(reason: String) = delegate.onFatalInfrastructureFailure(reason)
    override fun onControllerChannelClosed(reason: String) = delegate.onControllerChannelClosed(reason)
}
