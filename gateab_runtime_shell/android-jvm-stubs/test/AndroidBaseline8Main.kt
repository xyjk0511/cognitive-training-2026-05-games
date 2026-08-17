package com.a620.tablet.training

import android.os.ParcelFileDescriptor
import android.view.MotionEvent
import a620.CanonicalJson
import a620.RuntimeWireEnvelope
import a620.RuntimeIngressPriority
import a620.RuntimeWireEnvelopeParser
import a620.shell.PointerGateDecision
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private class TestMotionEvent(
    override val eventTime: Long,
    override val actionMasked: Int,
    private val ids: List<Int>,
    override val actionIndex: Int = 0,
) : MotionEvent() {
    override val pointerCount: Int get() = ids.size
    override fun getPointerId(index: Int): Int = ids[index]
}

private class RecordingSink : RuntimeMessageSink {
    val valid = CountDownLatch(1)
    val invalid = CountDownLatch(1)
    val stale = CountDownLatch(1)
    @Volatile var lastEnvelope: RuntimeWireEnvelope? = null
    @Volatile var lastViolation: String? = null
    @Volatile var staleCount: Int = 0

    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        lastEnvelope = envelope
        valid.countDown()
    }
    override fun onProtocolViolation(messageId: String?, reason: String) {
        lastViolation = "$messageId:$reason"
        invalid.countDown()
    }
    override fun onTelemetryDropped(messageId: String, messageType: String) = Unit
    override fun onStaleChannelMessage(messageId: String?, reason: String) {
        staleCount += 1
        stale.countDown()
    }
    override fun onFatalInfrastructureFailure(reason: String) = error(reason)
    override fun onControllerChannelClosed(reason: String) = Unit
}

private class NoopCallback : ITrainingRuntimeCallback.Stub() {
    val inlineLatch = CountDownLatch(1)
    @Volatile var inlineMessageType: String? = null
    @Volatile var inlineToken: String? = null
    @Volatile var inlineGeneration: Long = 0
    override fun onInlineEvent(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, channelGeneration: Long) {
        inlineMessageType = messageType
        inlineToken = channelToken
        inlineGeneration = channelGeneration
        inlineLatch.countDown()
    }
    override fun onBulkEvent(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, channelGeneration: Long) { payloadFd.close() }
    override fun onRuntimeInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long, channelToken: String, channelGeneration: Long) = Unit
}

private fun canonicalMessage(
    messageId: String,
    senderSeq: Long,
    taskId: String = "TASK-1",
    payload: Map<String, Any?> = linkedMapOf(),
): ByteArray = CanonicalJson.canonicalBytes(
    linkedMapOf(
        "contractVersion" to "A620-TRC-1.1",
        "messageType" to "PREPARE",
        "messageId" to messageId,
        "correlationId" to null,
        "senderRole" to "ANDROID_CONTROLLER",
        "senderSeq" to senderSeq,
        "sentAtUtc" to "2026-08-18T00:00:00Z",
        "sentAtUptimeMs" to 100L + senderSeq,
        "monotonicEpochId" to "BOOT-1",
        "systemId" to "SYS-1",
        "deviceId" to "DEV-1",
        "taskId" to taskId,
        "taskItemId" to "ITEM-1",
        "executionAttempt" to 1L,
        "runtimeSessionId" to "RUN-1",
        "packageVersion" to "1.0.0",
        "coreProtocolVersion" to "CP-1",
        "payload" to payload,
    ),
)

private fun envelope(bytes: ByteArray): RuntimeWireEnvelope = RuntimeWireEnvelopeParser.parseCanonical(bytes)

private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun testTouchCancellation() {
    val gate = AndroidTouchInputGate()
    check(gate.configure(100, 200) == PointerGateDecision.DROP)
    check(gate.evaluate(TestMotionEvent(150, MotionEvent.ACTION_DOWN, listOf(4))) == PointerGateDecision.FORWARD)
    check(gate.evaluate(TestMotionEvent(200, MotionEvent.ACTION_UP, listOf(4))) == PointerGateDecision.CANCEL_STREAM)
    check(gate.configure(300, 400) == PointerGateDecision.DROP)
    check(gate.evaluate(TestMotionEvent(350, MotionEvent.ACTION_DOWN, listOf(5))) == PointerGateDecision.FORWARD)
    check(gate.close() == PointerGateDecision.CANCEL_STREAM)
}

private fun testStrictInlineIngress() {
    val sink = RecordingSink()
    val actor = TrainingRuntimeActor()
    val token = ChannelAuthenticator.generateToken()
    val coordinator = CanonicalIngressCoordinator("ANDROID_CONTROLLER", actor, sink) { generation, suppliedToken ->
        generation == 1L && ChannelAuthenticator.constantTimeSameToken(token, suppliedToken)
    }
    val good = canonicalMessage("MSG-1", 1)
    coordinator.submitInline("PREPARE", "MSG-1", 1, good, sha256(good), 1, token)
    check(sink.valid.await(2, TimeUnit.SECONDS))
    check(sink.lastEnvelope?.messageId == "MSG-1")

    val bad = canonicalMessage("MSG-2", 2)
    coordinator.submitInline("PAUSE", "MSG-2", 2, bad, sha256(bad), 1, token)
    check(sink.invalid.await(2, TimeUnit.SECONDS))
    check(sink.lastViolation?.contains("AIDL messageType differs") == true)
    coordinator.close()
    actor.shutdownNow()
}

private fun testChannelAuthenticationAndRotation() {
    val token = ChannelAuthenticator.generateToken()
    val token2 = ChannelAuthenticator.generateToken()
    check(token.length == RuntimePolicy.CHANNEL_TOKEN_CHARS)
    check(token != token2)
    check(ChannelAuthenticator.matches(token, ChannelAuthenticator.digest(token)))
    check(!ChannelAuthenticator.matches(token2, ChannelAuthenticator.digest(token)))
    check(!ChannelAuthenticator.matches("bad", ChannelAuthenticator.digest(token)))

    val service = TrainingRuntimeService()
    val remote = service.onBind(null) as ITrainingRuntime
    val callback = NoopCallback()
    remote.registerCallback(callback, token, 1L)
    val bytes = canonicalMessage("AUTH-1", 1)
    remote.submitInline("PREPARE", "AUTH-1", 1, bytes, sha256(bytes), token, 1L)
    check(runCatching { remote.submitInline("PREPARE", "AUTH-2", 2, canonicalMessage("AUTH-2", 2), sha256(canonicalMessage("AUTH-2", 2)), token2, 1L) }.isFailure)

    remote.registerCallback(callback, token2, 2L)
    check(runCatching { remote.closeChannel(token, 2L, "OLD_TOKEN") }.isFailure)
    remote.closeChannel(token2, 2L, "TEST_COMPLETE")
    service.onDestroy()
}


private fun canonicalCocosEvent(messageId: String, senderSeq: Long): ByteArray = CanonicalJson.canonicalBytes(
    linkedMapOf(
        "contractVersion" to "A620-TRC-1.1",
        "messageType" to "HEARTBEAT",
        "messageId" to messageId,
        "correlationId" to null,
        "senderRole" to "COCOS_RUNTIME",
        "senderSeq" to senderSeq,
        "sentAtUtc" to "2026-08-18T00:00:00Z",
        "sentAtUptimeMs" to 200L + senderSeq,
        "monotonicEpochId" to "BOOT-1",
        "systemId" to "SYS-1",
        "deviceId" to "DEV-1",
        "taskId" to "TASK-1",
        "taskItemId" to "ITEM-1",
        "executionAttempt" to 1L,
        "runtimeSessionId" to "RUN-1",
        "packageVersion" to "1.0.0",
        "coreProtocolVersion" to "CP-1",
        "payload" to linkedMapOf<String, Any?>(),
    ),
)

private fun testBidirectionalInlineTransportUsesCurrentChannelFence() {
    val service = TrainingRuntimeService()
    val remote = service.onBind(null) as ITrainingRuntime
    val callback = NoopCallback()
    val token = ChannelAuthenticator.generateToken()
    remote.registerCallback(callback, token, 1L)
    val bytes = canonicalCocosEvent("COCOS-EVT-1", 1)
    service.eventTransport.send(envelope(bytes), bytes)
    check(callback.inlineLatch.await(2, TimeUnit.SECONDS))
    check(callback.inlineMessageType == "HEARTBEAT")
    check(callback.inlineToken == token)
    check(callback.inlineGeneration == 1L)
    service.onDestroy()
}

private fun testStrictRuntimeLedger() {
    val sink = StrictRuntimeMessageSink()
    val first = canonicalMessage("LEDGER-1", 1)
    sink.onCanonicalMessage(envelope(first), first)
    sink.onCanonicalMessage(envelope(first), first)
    var snapshot = sink.snapshot()
    check(snapshot.acceptedMessages == 1L)
    check(snapshot.replayedMessages == 1L)
    check(snapshot.senderSeqCursor["ANDROID_CONTROLLER"] == 1L)

    val second = canonicalMessage("LEDGER-2", 2)
    sink.onCanonicalMessage(envelope(second), second)
    snapshot = sink.snapshot()
    check(snapshot.acceptedMessages == 2L)
    check(snapshot.messageCount == 2)

    val changedIdentity = canonicalMessage("LEDGER-3", 3, taskId = "TASK-OTHER")
    check(runCatching { sink.onCanonicalMessage(envelope(changedIdentity), changedIdentity) }.isFailure)

    sink.onProtocolViolation("LEDGER-X", "FORCED")
    check(sink.snapshot().terminalReason?.startsWith("PROTOCOL_VIOLATION") == true)
    val later = canonicalMessage("LEDGER-4", 4)
    check(runCatching { sink.onCanonicalMessage(envelope(later), later) }.isFailure)
}


private fun testAsyncFenceRejectsOldBindingAfterRotation() {
    val sink = RecordingSink()
    val actor = TrainingRuntimeActor()
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    actor.submit(RuntimeIngressPriority.NORMAL, 1) {
        entered.countDown()
        release.await()
    }
    check(entered.await(2, TimeUnit.SECONDS))

    val token1 = ChannelAuthenticator.generateToken()
    val token2 = ChannelAuthenticator.generateToken()
    val liveToken = AtomicReference(token1)
    val liveGeneration = AtomicLong(1L)
    val coordinator = CanonicalIngressCoordinator("ANDROID_CONTROLLER", actor, sink) { generation, suppliedToken ->
        generation == liveGeneration.get() && ChannelAuthenticator.constantTimeSameToken(liveToken.get(), suppliedToken)
    }
    val old = canonicalMessage("STALE-1", 1)
    coordinator.submitInline("PREPARE", "STALE-1", 1, old, sha256(old), 1, token1)
    liveToken.set(token2)
    liveGeneration.set(2L)
    release.countDown()
    check(sink.stale.await(2, TimeUnit.SECONDS))
    check(sink.staleCount == 1)
    check(sink.lastEnvelope == null)
    check(sink.lastViolation == null)
    coordinator.close()
    actor.shutdownNow()
}


private fun canonicalResultReady(messageId: String, senderSeq: Long, sentAtUptimeMs: Long): ByteArray =
    CanonicalJson.canonicalBytes(
        linkedMapOf(
            "contractVersion" to "A620-TRC-1.1",
            "messageType" to "RESULT_READY",
            "messageId" to messageId,
            "correlationId" to null,
            "senderRole" to "COCOS_RUNTIME",
            "senderSeq" to senderSeq,
            "sentAtUtc" to "2026-08-18T00:00:00Z",
            "sentAtUptimeMs" to sentAtUptimeMs,
            "monotonicEpochId" to "BOOT-1",
            "systemId" to "SYS-1",
            "deviceId" to "DEV-1",
            "taskId" to "TASK-1",
            "taskItemId" to "ITEM-1",
            "executionAttempt" to 1L,
            "runtimeSessionId" to "RUN-1",
            "packageVersion" to "1.0.0",
            "coreProtocolVersion" to "CP-1",
            "payload" to linkedMapOf<String, Any?>(
                "resultDraftSha256" to "a".repeat(64),
                "gamePayload" to linkedMapOf<String, Any?>(),
            ),
        ),
    )

private fun testCommittedResultReplayRequiresExactCanonicalBytes() {
    val first = canonicalResultReady("RESULT-READY-1", 10L, 1000L)
    val firstEnvelope = envelope(first)
    FormalResultReplayValidator.requireExactReplay(
        incoming = firstEnvelope,
        incomingCanonical = first,
        persistedResultReadyMessageId = firstEnvelope.messageId,
        persistedResultReadyCanonical = first,
        persistedResultPayloadSha256 = "a".repeat(64),
    )

    val changed = canonicalResultReady("RESULT-READY-1", 10L, 1001L)
    check(runCatching {
        FormalResultReplayValidator.requireExactReplay(
            incoming = envelope(changed),
            incomingCanonical = changed,
            persistedResultReadyMessageId = firstEnvelope.messageId,
            persistedResultReadyCanonical = first,
            persistedResultPayloadSha256 = "a".repeat(64),
        )
    }.isFailure)
}

private fun testCommonGamePayloadValidationAndEvidenceEquality() {
    fun batch(ordinal: Long, before: Long, after: Long, score: Long): LinkedHashMap<String, Any?> {
        val value = linkedMapOf<String, Any?>(
            "batchOrdinal" to ordinal,
            "closed" to true,
            "decisionEligible" to true,
            "levelBefore" to before,
            "resultZone" to "UPGRADE",
            "levelTransition" to "UP",
            "levelAfter" to after,
            "batchScore" to score,
            "closedAtActiveMs" to ordinal * 37_500L,
            "gameBatchMetrics" to linkedMapOf<String, Any?>(),
        )
        value["batchPayloadSha256"] = CanonicalJson.sha256(value)
        return value
    }
    val b1 = batch(1, 1, 2, 80)
    val evidence = listOf(
        DurableBatchEvidence(1, b1["batchPayloadSha256"] as String, CanonicalJson.canonicalBytes(b1)),
    )
    val payload = linkedMapOf<String, Any?>(
        "gameCode" to "CATCH_LIGHT",
        "gamePayloadVersion" to "A620-GP-1.1",
        "runtimeConfigHash" to "a".repeat(64),
        "designMaxLevel" to 120L,
        "plannedBatchCount" to 8L,
        "eligibleBatchCount" to 1L,
        "eligibleBatches" to listOf(b1),
        "incompleteBatchAudit" to listOf(
            linkedMapOf<String, Any?>(
                "batchOrdinal" to 2L,
                "levelBefore" to 2L,
                "cutoffReason" to "DEADLINE",
                "startedAtActiveMs" to 37_500L,
                "cutoffAtActiveMs" to 300_000L,
                "partialMetrics" to linkedMapOf<String, Any?>(),
            ),
        ),
        "sessionStartLevel" to 1L,
        "sessionEndLevel" to 2L,
        "sessionHighestPresentedLevel" to 2L,
        "sessionHighestPassedLevel" to 1L,
        "nextStartLevel" to 2L,
        "sessionRawScore" to 80L,
        "sessionRawScoreMax" to 800L,
        "actualTrainingMs" to 300_000L,
        "gameMetrics" to linkedMapOf<String, Any?>(),
    )
    val facts = PreparedRuntimeFacts("CATCH_LIGHT", "a".repeat(64), 8, 1, 300_000)
    val summary = CommonGamePayloadValidator.validate(payload, facts, evidence)
    check(summary.derivedQualityFlag == "PARTIAL_ELIGIBLE_BATCHES")
    check(summary.nextStartLevel == 2L)

    val tamperedBatch = LinkedHashMap(b1).apply { put("batchScore", 99L) }
    val tamperedPayload = LinkedHashMap(payload).apply {
        put("eligibleBatches", listOf(tamperedBatch))
        put("sessionRawScore", 99L)
    }
    check(runCatching { CommonGamePayloadValidator.validate(tamperedPayload, facts, evidence) }.isFailure)
}


private fun canonicalAck(messageId: String = "ACK-1", senderSeq: Long = 2L): ByteArray = CanonicalJson.canonicalBytes(
    linkedMapOf(
        "contractVersion" to "A620-TRC-1.1",
        "messageType" to "ACK_RESULT_COMMITTED",
        "messageId" to messageId,
        "correlationId" to "RESULT-READY-1",
        "senderRole" to "ANDROID_CONTROLLER",
        "senderSeq" to senderSeq,
        "sentAtUtc" to "2026-08-18T00:00:01Z",
        "sentAtUptimeMs" to 1_000L,
        "monotonicEpochId" to "BOOT-1",
        "systemId" to "SYS-1",
        "deviceId" to "DEV-1",
        "taskId" to "TASK-1",
        "taskItemId" to "ITEM-1",
        "executionAttempt" to 1L,
        "runtimeSessionId" to "RUN-1",
        "packageVersion" to "1.0.0",
        "coreProtocolVersion" to "CP-1",
        "payload" to linkedMapOf<String, Any?>(
            "resultId" to "RES-1",
            "resultPayloadSha256" to "a".repeat(64),
            "committedAtUtc" to "2026-08-18T00:00:01Z",
            "committedAtUptimeMs" to 1_000L,
        ),
    ),
)

private class FakeControllerOutboxStore(
    private val available: MutableList<ClaimedControllerMessage>,
) : ControllerOutboxStore {
    val submitted = mutableListOf<String>()
    val retries = mutableListOf<String>()
    val poisoned = mutableListOf<String>()

    override fun claimDueControllerOutbox(runtimeSessionId: String, ownerId: String, nowUtcMs: Long, leaseMs: Long, limit: Int): List<ClaimedControllerMessage> {
        val claimed = available
            .filter { it.runtimeSessionId == runtimeSessionId }
            .minByOrNull { it.senderSeq }
            ?.let(::listOf)
            ?: emptyList()
        available.removeAll(claimed.toSet())
        return claimed
    }

    override fun nextControllerOutboxDueAtUtcMs(runtimeSessionId: String): Long? =
        if (available.any { it.runtimeSessionId == runtimeSessionId }) 0L else null

    override fun markControllerOutboxSubmitted(messageId: String, ownerId: String, claimGeneration: Long) {
        submitted += messageId
    }

    override fun markControllerOutboxRetry(messageId: String, ownerId: String, claimGeneration: Long, nextAttemptAtUtcMs: Long, error: String) {
        retries += messageId
    }

    override fun markControllerOutboxPoisoned(messageId: String, ownerId: String, claimGeneration: Long, error: String) {
        poisoned += messageId
    }
}

private fun testDurableControllerOutboxDispatch() {
    val bytes = canonicalAck()
    val claim = ClaimedControllerMessage(
        messageId = "ACK-1",
        runtimeSessionId = "RUN-1",
        messageType = "ACK_RESULT_COMMITTED",
        senderSeq = 2L,
        canonicalSha256 = sha256(bytes),
        canonicalJson = bytes,
        attemptCount = 0,
        claimGeneration = 1L,
    )
    val other = claim.copy(messageId = "ACK-OTHER", runtimeSessionId = "RUN-OTHER")
    val store = FakeControllerOutboxStore(mutableListOf(other, claim))
    val sent = mutableListOf<String>()
    val dispatcher = ControllerOutboxDispatcher(
        runtimeSessionId = "RUN-1",
        store = store,
        sender = CanonicalControllerSender { envelope, canonical ->
            check(canonical.contentEquals(bytes))
            sent += envelope.messageId
        },
        onFatalFailure = { error(it) },
        ownerId = "OUTBOX-TEST",
        nowUtcMs = { 2_000L },
    )
    val summary = dispatcher.drainOnce()
    check(summary == OutboxDispatchSummary(1, 1, 0, 0))
    check(sent == listOf("ACK-1"))
    check(store.submitted == listOf("ACK-1"))
    dispatcher.close()

    val seq2 = claim.copy(messageId = "ACK-SEQ-2", senderSeq = 2L, canonicalJson = canonicalAck("ACK-SEQ-2", 2L)).let {
        it.copy(canonicalSha256 = sha256(it.canonicalJson))
    }
    val seq3 = claim.copy(messageId = "ACK-SEQ-3", senderSeq = 3L, canonicalJson = canonicalAck("ACK-SEQ-3", 3L)).let {
        it.copy(canonicalSha256 = sha256(it.canonicalJson))
    }
    val orderedStore = FakeControllerOutboxStore(mutableListOf(seq3, seq2))
    val orderedSent = mutableListOf<Long>()
    val orderedDispatcher = ControllerOutboxDispatcher(
        runtimeSessionId = "RUN-1",
        store = orderedStore,
        sender = CanonicalControllerSender { event, _ -> orderedSent += event.senderSeq },
        onFatalFailure = { error(it) },
        ownerId = "OUTBOX-ORDER",
        nowUtcMs = { 2_500L },
    )
    val orderedSummary = orderedDispatcher.drainOnce()
    check(orderedSummary == OutboxDispatchSummary(2, 2, 0, 0))
    check(orderedSent == listOf(2L, 3L))
    orderedDispatcher.close()

    val retryStore = FakeControllerOutboxStore(mutableListOf(claim.copy(claimGeneration = 2L)))
    val retryDispatcher = ControllerOutboxDispatcher(
        runtimeSessionId = "RUN-1",
        store = retryStore,
        sender = CanonicalControllerSender { _, _ -> throw IllegalStateException("binder unavailable") },
        onFatalFailure = { error(it) },
        ownerId = "OUTBOX-RETRY",
        nowUtcMs = { 3_000L },
    )
    val retrySummary = retryDispatcher.drainOnce()
    check(retrySummary == OutboxDispatchSummary(1, 0, 1, 0))
    check(retryStore.retries == listOf("ACK-1"))
    retryDispatcher.close()
}

fun main() {
    testTouchCancellation()
    testStrictInlineIngress()
    testChannelAuthenticationAndRotation()
    testBidirectionalInlineTransportUsesCurrentChannelFence()
    testStrictRuntimeLedger()
    testAsyncFenceRejectsOldBindingAfterRotation()
    testCommittedResultReplayRequiresExactCanonicalBytes()
    testCommonGamePayloadValidationAndEvidenceEquality()
    testDurableControllerOutboxDispatch()
    println("ANDROID_STUB_BASELINE8_AUTH_DURABLE_CONTROLLER_TEST_PASS")
}
