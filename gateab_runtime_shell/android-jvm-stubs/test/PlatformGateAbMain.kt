package com.a620.tablet.training

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Binder
import android.os.IBinder
import android.os.ParcelFileDescriptor
import a620.CanonicalJson
import a620.RuntimeIngressPriority
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import com.a620.tablet.A620Application
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

private const val CONFIG_HASH = "47ec3d8b614b6c48189a7e1abc9e20b05b7c3e080d15d62bcbeccd2404653207"

private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun envelope(bytes: ByteArray, role: String? = null): RuntimeWireEnvelope =
    RuntimeWireEnvelopeParser.parseCanonical(bytes, expectedSenderRole = role)

private fun controllerBytes(
    messageType: String,
    messageId: String,
    senderSeq: Long,
    payload: Map<String, Any?>,
    executionAttempt: Long = 1L,
    runtimeSessionId: String = "RUN-W1",
    sentAtUptimeMs: Long = 100L + senderSeq,
): ByteArray = CanonicalJson.canonicalBytes(linkedMapOf<String, Any?>(
    "contractVersion" to "A620-TRC-1.1",
    "messageType" to messageType,
    "messageId" to messageId,
    "correlationId" to null,
    "senderRole" to "ANDROID_CONTROLLER",
    "senderSeq" to senderSeq,
    "sentAtUtc" to "2026-08-18T02:00:00Z",
    "sentAtUptimeMs" to sentAtUptimeMs,
    "monotonicEpochId" to "BOOT-W1",
    "systemId" to "SYS-W1",
    "deviceId" to "TAB-W1",
    "taskId" to "TASK-W1",
    "taskItemId" to "ITEM-W1",
    "executionAttempt" to executionAttempt,
    "runtimeSessionId" to runtimeSessionId,
    "packageVersion" to "0.0.9-w1",
    "coreProtocolVersion" to "1.1",
    "payload" to LinkedHashMap(payload),
))

private fun prepareBytes(
    messageId: String = "CMD-PREPARE",
    senderSeq: Long = 1L,
    padding: Int = 0,
    executionAttempt: Long = 1L,
    runtimeSessionId: String = "RUN-W1",
): ByteArray {
    val config = linkedMapOf<String, Any?>()
    if (padding > 0) config["transportPadding"] = "x".repeat(padding)
    return controllerBytes(messageId = messageId, messageType = "PREPARE", senderSeq = senderSeq,
        executionAttempt = executionAttempt, runtimeSessionId = runtimeSessionId,
        payload = linkedMapOf(
            "clockProfile" to "A620-UPTIME-MS-1",
            "durationMs" to 300_000L,
            "sessionSeed" to 1L,
            "sessionStartLevel" to 1L,
            "designMaxLevel" to 96L,
            "plannedBatchCount" to 8L,
            "runtimeConfigHash" to CONFIG_HASH,
            "scoringRuleVersion" to "W1-MOCK-1",
            "resultSchemaVersion" to "A620-TRR-1.1",
            "generatorVersion" to "W1-MOCK-GEN-1",
            "gameCode" to "GATEAB_MOCK",
            "gameConfigSchemaId" to "urn:a620:gateab:mock:1",
            "gameConfig" to config,
        ))
}

private fun cocosBytes(
    messageType: String,
    messageId: String,
    senderSeq: Long,
    payload: Map<String, Any?>,
): ByteArray = CanonicalJson.canonicalBytes(linkedMapOf<String, Any?>(
    "contractVersion" to "A620-TRC-1.1",
    "messageType" to messageType,
    "messageId" to messageId,
    "correlationId" to null,
    "senderRole" to "COCOS_RUNTIME",
    "senderSeq" to senderSeq,
    "sentAtUtc" to "2026-08-18T02:00:01Z",
    "sentAtUptimeMs" to 200L + senderSeq,
    "monotonicEpochId" to "BOOT-W1",
    "systemId" to "SYS-W1",
    "deviceId" to "TAB-W1",
    "taskId" to "TASK-W1",
    "taskItemId" to "ITEM-W1",
    "executionAttempt" to 1L,
    "runtimeSessionId" to "RUN-W1",
    "packageVersion" to "0.0.9-w1",
    "coreProtocolVersion" to "1.1",
    "payload" to LinkedHashMap(payload),
))

private fun startBytes(seq: Long = 2L) = controllerBytes("START", "CMD-START", seq, linkedMapOf(
    "effectiveStartUptimeMs" to 1_000L,
    "cutoffUptimeMs" to 301_000L,
    "activeElapsedMs" to 0L,
    "clockRevision" to 1L,
    "commandLeadTimeMs" to 500L,
))

private fun pauseBytes(seq: Long = 3L) = controllerBytes("PAUSE", "CMD-PAUSE", seq, linkedMapOf(
    "effectivePauseUptimeMs" to 60_300L,
    "activeElapsedMs" to 59_300L,
    "clockRevision" to 2L,
    "pauseLeadTimeMs" to 300L,
    "reasonCode" to "THERAPIST_PAUSE",
))

private fun resumeBytes(seq: Long = 4L) = controllerBytes("RESUME", "CMD-RESUME", seq, linkedMapOf(
    "countdownMs" to 3_000L,
    "resumeInputEnabledUptimeMs" to 68_000L,
    "cutoffUptimeMs" to 308_700L,
    "activeElapsedMs" to 59_300L,
    "clockRevision" to 3L,
))

private fun deadlineBytes(seq: Long = 5L) = controllerBytes("DEADLINE", "CMD-DEADLINE", seq, linkedMapOf(
    "cutoffUptimeMs" to 308_700L,
    "activeElapsedMs" to 300_000L,
    "clockRevision" to 3L,
))

private fun ackBytes(hash: String, seq: Long = 6L) = controllerBytes("ACK_RESULT_COMMITTED", "CMD-ACK", seq, linkedMapOf(
    "resultId" to "RESULT-W1",
    "resultPayloadSha256" to hash,
    "committedAtUtc" to "2026-08-18T02:00:02Z",
    "committedAtUptimeMs" to 309_000L,
))

private fun readExactly(fd: ParcelFileDescriptor, declared: Long): ByteArray {
    val owned = ParcelFileDescriptor.dup(fd.fileDescriptor)
    return ParcelFileDescriptor.AutoCloseInputStream(owned).use { input ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            out.write(buffer, 0, count)
        }
        out.toByteArray().also { check(it.size.toLong() == declared) }
    }
}

private fun requireEventually(label: String, timeoutMs: Long = 3_000, predicate: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (System.nanoTime() < deadline) {
        if (predicate()) return
        Thread.sleep(10)
    }
    check(predicate()) { "timed out: $label" }
}

private fun testMockGameCommonPayloadForZeroOneSevenEight() {
    for (target in listOf(0, 1, 7, 8)) {
        val prepare = envelope(prepareBytes(runtimeSessionId = "RUN-MOCK-$target"), "ANDROID_CONTROLLER")
        val game = DeviceShellMockGame(target)
        game.prepare(prepare)
        game.start()
        if (target == 7) { game.pause(); game.resume() }
        val result = game.deadline()
        val durable = result.batches.map {
            DurableBatchEvidence(
                batchOrdinal = it.ordinal,
                payloadSha256 = it.payload.getValue("batchPayloadSha256") as String,
                canonicalPayload = CanonicalJson.canonicalBytes(it.payload),
            )
        }
        val summary = CommonGamePayloadValidator.validate(
            result.gamePayload,
            PreparedRuntimeFacts("GATEAB_MOCK", CONFIG_HASH, 8L, 1L, 300_000L),
            durable,
        )
        check(summary.eligibleBatchCount == target.toLong())
        check(summary.derivedQualityFlag == when (target) {
            0 -> "NO_ELIGIBLE_BATCH"
            8 -> "COMPLETE_BATCH_SET"
            else -> "PARTIAL_ELIGIBLE_BATCHES"
        })
        check(game.deadline() === result)
    }
}

private fun testMockRuntimePauseResumeDeadlineRetryAndAck() {
    val events = Collections.synchronizedList(mutableListOf<Pair<RuntimeWireEnvelope, ByteArray>>())
    val interruptions = Collections.synchronizedList(mutableListOf<String>())
    val runtime = DeviceShellMockRuntime(
        eventSender = DeviceRuntimeEventSender { event, bytes -> events += event to bytes.copyOf() },
        interruptionSender = { _, reason, _ -> interruptions += reason },
    )
    val commands = listOf(prepareBytes(), startBytes(), pauseBytes(), resumeBytes(), deadlineBytes())
    commands.forEach { bytes -> runtime.onCanonicalMessage(envelope(bytes, "ANDROID_CONTROLLER"), bytes) }
    check(events.first().first.messageType == "READY")
    check(events.count { it.first.messageType == "BATCH_CLOSED" } == 8)
    val firstResult = events.single { it.first.messageType == "RESULT_READY" }
    runtime.onCanonicalMessage(envelope(commands.last(), "ANDROID_CONTROLLER"), commands.last())
    val replayResult = events.last()
    check(replayResult.first == firstResult.first)
    check(replayResult.second.contentEquals(firstResult.second))
    val resultHash = firstResult.first.payload.getValue("resultDraftSha256") as String
    val ack = ackBytes(resultHash)
    runtime.onCanonicalMessage(envelope(ack, "ANDROID_CONTROLLER"), ack)
    check(runtime.stateForTest() == DeviceMockState.RESULT_COMMITTED)
    check(interruptions.isEmpty())

    val strict = StrictRuntimeMessageSink()
    val original = prepareBytes(messageId = "SAME-ID")
    strict.onCanonicalMessage(envelope(original, "ANDROID_CONTROLLER"), original)
    val different = prepareBytes(messageId = "SAME-ID", padding = 1)
    check(runCatching {
        strict.onCanonicalMessage(envelope(different, "ANDROID_CONTROLLER"), different)
    }.exceptionOrNull()?.message?.contains("different canonical content") == true)

    val newAttempt = prepareBytes(messageId = "NEW-ATTEMPT", senderSeq = 2, executionAttempt = 2, runtimeSessionId = "RUN-W1-2")
    check(runCatching {
        strict.onCanonicalMessage(envelope(newAttempt, "ANDROID_CONTROLLER"), newAttempt)
    }.exceptionOrNull()?.message?.contains("identity changed") == true)
}

private class CapturingCommandChannel : ControllerCommandChannel {
    val received = Collections.synchronizedList(mutableListOf<ByteArray>())
    val bulkCount = AtomicInteger(0)
    override fun submitInline(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String) {
        check(sha256(canonicalJson) == canonicalSha256)
        received += canonicalJson.copyOf()
    }
    override fun submitBulk(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String) {
        bulkCount.incrementAndGet()
        val bytes = readExactly(payloadFd, byteLength)
        check(sha256(bytes) == canonicalSha256)
        received += bytes
    }
}

private fun testControllerToRuntimeInlineAndPfdTransport() {
    val baseline = ParcelFileDescriptor.activeDescriptorCountForTest()
    val channel = CapturingCommandChannel()
    val fatal = Collections.synchronizedList(mutableListOf<String>())
    val transport = ControllerCommandTransport(channel) { fatal += it }
    val inline = prepareBytes()
    transport.send(envelope(inline, "ANDROID_CONTROLLER"), inline)
    val bulk = prepareBytes(messageId = "CMD-PREPARE-BULK", senderSeq = 2, padding = 100_000)
    transport.send(envelope(bulk, "ANDROID_CONTROLLER"), bulk)
    requireEventually("controller bulk delivered") { channel.received.size == 2 }
    check(channel.bulkCount.get() == 1)
    check(channel.received[0].contentEquals(inline))
    check(channel.received[1].contentEquals(bulk))
    check(fatal.isEmpty())
    transport.close()
    requireEventually("controller PFD closed") { ParcelFileDescriptor.activeDescriptorCountForTest() == baseline }
}

private fun testControllerPfdWriteFailureFailsClosed() {
    val fatalLatch = CountDownLatch(1)
    val transport = ControllerCommandTransport(object : ControllerCommandChannel {
        override fun submitInline(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String) = Unit
        override fun submitBulk(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String) {
            // Deliberately return without duplicating/reading. Sender closes the read end.
        }
    }) { fatalLatch.countDown() }
    val bulk = prepareBytes(messageId = "CMD-WRITE-FAIL", padding = 200_000)
    transport.send(envelope(bulk, "ANDROID_CONTROLLER"), bulk)
    check(fatalLatch.await(3, TimeUnit.SECONDS))
    transport.close()
}

private fun testRuntimeToControllerPfdTransport() {
    val baseline = ParcelFileDescriptor.activeDescriptorCountForTest()
    val captured = Collections.synchronizedList(mutableListOf<ByteArray>())
    val callback = object : ITrainingRuntimeCallback.Stub() {
        override fun onInlineEvent(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, channelGeneration: Long) {
            check(sha256(canonicalJson) == canonicalSha256); captured += canonicalJson.copyOf()
        }
        override fun onBulkEvent(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, channelGeneration: Long) {
            val bytes = readExactly(payloadFd, byteLength)
            check(sha256(bytes) == canonicalSha256); captured += bytes
        }
        override fun onRuntimeInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long, channelToken: String, channelGeneration: Long) = Unit
    }
    val token = ChannelAuthenticator.generateToken()
    val channel = TrainingRuntimeService.CallbackChannel(callback, token, 1L)
    val fatal = Collections.synchronizedList(mutableListOf<String>())
    val transport = RuntimeEventTransport({ channel }) { fatal += it }
    val inline = cocosBytes("STATE_SNAPSHOT", "EVT-INLINE", 1, linkedMapOf(
        "runtimeState" to "READY", "activeElapsedMs" to 0L, "clockRevision" to 0L, "lastAppliedControllerSeq" to 1L,
    ))
    transport.send(envelope(inline, "COCOS_RUNTIME"), inline)
    val game = DeviceShellMockGame(8)
    val prepare = envelope(prepareBytes(), "ANDROID_CONTROLLER")
    game.prepare(prepare); game.start()
    val gp = game.deadline().gamePayload
    @Suppress("UNCHECKED_CAST")
    (gp["gameMetrics"] as MutableMap<String, Any?>)["padding"] = "y".repeat(100_000)
    val bulk = cocosBytes("RESULT_READY", "EVT-BULK", 2, linkedMapOf(
        "resultDraftSha256" to CanonicalJson.sha256(gp), "gamePayload" to gp,
    ))
    transport.send(envelope(bulk, "COCOS_RUNTIME"), bulk)
    requireEventually("runtime bulk delivered") { captured.size == 2 }
    check(captured[0].contentEquals(inline) && captured[1].contentEquals(bulk))
    check(fatal.isEmpty())
    transport.close()
    requireEventually("runtime PFD closed") { ParcelFileDescriptor.activeDescriptorCountForTest() == baseline }
}

private class ProbeSink : RuntimeMessageSink {
    val accepted = Collections.synchronizedList(mutableListOf<String>())
    val violations = Collections.synchronizedList(mutableListOf<String>())
    val stale = Collections.synchronizedList(mutableListOf<String>())
    val dropped = Collections.synchronizedList(mutableListOf<String>())
    val fatals = Collections.synchronizedList(mutableListOf<String>())
    val violationLatch = CountDownLatch(1)
    val staleLatch = CountDownLatch(1)
    val droppedLatch = CountDownLatch(1)
    val fatalLatch = CountDownLatch(1)
    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) { accepted += envelope.messageId }
    override fun onProtocolViolation(messageId: String?, reason: String) { violations += reason; violationLatch.countDown() }
    override fun onTelemetryDropped(messageId: String, messageType: String) { dropped += "$messageId:$messageType"; droppedLatch.countDown() }
    override fun onStaleChannelMessage(messageId: String?, reason: String) { stale += reason; staleLatch.countDown() }
    override fun onFatalInfrastructureFailure(reason: String) { fatals += reason; fatalLatch.countDown() }
    override fun onControllerChannelClosed(reason: String) = Unit
}

private fun writePipe(writeEnd: ParcelFileDescriptor, bytes: ByteArray) {
    ParcelFileDescriptor.AutoCloseOutputStream(writeEnd).use { it.write(bytes); it.flush() }
}

private fun testOldPfdLateAfterRotationTimeoutAndShortRead() {
    val baseline = ParcelFileDescriptor.activeDescriptorCountForTest()
    val actor = TrainingRuntimeActor()
    val sink = ProbeSink()
    val liveToken = AtomicReference(ChannelAuthenticator.generateToken())
    val ingress = CanonicalIngressCoordinator("ANDROID_CONTROLLER", actor, sink, bulkReadTimeoutMs = 1_000) { g, t ->
        g == 1L && ChannelAuthenticator.constantTimeSameToken(liveToken.get(), t)
    }
    val oldToken = liveToken.get()
    val bytes = prepareBytes(messageId = "CMD-LATE-PFD", padding = 70_000)
    val pipe = ParcelFileDescriptor.createPipe()
    pipe[0].use { ingress.submitBulk("PREPARE", "CMD-LATE-PFD", 1, it, bytes.size.toLong(), sha256(bytes), 1L, oldToken) }
    liveToken.set(ChannelAuthenticator.generateToken())
    writePipe(pipe[1], bytes)
    check(sink.staleLatch.await(3, TimeUnit.SECONDS))
    check(sink.accepted.isEmpty())
    ingress.close(); actor.shutdownNow()

    val timeoutActor = TrainingRuntimeActor()
    val timeoutSink = ProbeSink()
    val timeoutToken = ChannelAuthenticator.generateToken()
    val timeoutIngress = CanonicalIngressCoordinator("ANDROID_CONTROLLER", timeoutActor, timeoutSink, bulkReadTimeoutMs = 50) { g, t ->
        g == 1L && ChannelAuthenticator.constantTimeSameToken(timeoutToken, t)
    }
    val timeoutPipe = ParcelFileDescriptor.createPipe()
    timeoutPipe[0].use { timeoutIngress.submitBulk("PREPARE", "CMD-TIMEOUT", 1, it, 100L, "0".repeat(64), 1L, timeoutToken) }
    check(timeoutSink.violationLatch.await(2, TimeUnit.SECONDS))
    check(timeoutSink.violations.single().contains("BULK_PAYLOAD_LEASE_EXPIRED"))
    timeoutPipe[1].close(); timeoutIngress.close(); timeoutActor.shutdownNow()

    val shortActor = TrainingRuntimeActor()
    val shortSink = ProbeSink()
    val shortToken = ChannelAuthenticator.generateToken()
    val shortIngress = CanonicalIngressCoordinator("ANDROID_CONTROLLER", shortActor, shortSink, bulkReadTimeoutMs = 1_000) { g, t ->
        g == 1L && ChannelAuthenticator.constantTimeSameToken(shortToken, t)
    }
    val shortPipe = ParcelFileDescriptor.createPipe()
    shortPipe[0].use { shortIngress.submitBulk("PREPARE", "CMD-SHORT", 1, it, 20L, sha256(byteArrayOf(1, 2)), 1L, shortToken) }
    writePipe(shortPipe[1], byteArrayOf(1, 2))
    check(shortSink.violationLatch.await(2, TimeUnit.SECONDS))
    check(shortSink.violations.single().contains("bulk length mismatch"))
    shortIngress.close(); shortActor.shutdownNow()
    requireEventually("ingress descriptors released") { ParcelFileDescriptor.activeDescriptorCountForTest() == baseline }
}

private fun testBackpressureDropsOnlyTelemetryAndFailsClosedOtherwise() {
    fun saturatedActor(): Pair<TrainingRuntimeActor, CountDownLatch> {
        val release = CountDownLatch(1)
        val started = CountDownLatch(1)
        val actor = TrainingRuntimeActor(urgentMaxMessages = 1, urgentMaxBytes = 200_000, normalMaxMessages = 1, normalMaxBytes = 200_000)
        actor.submit(RuntimeIngressPriority.NORMAL, 1) { started.countDown(); release.await(3, TimeUnit.SECONDS) }
        check(started.await(1, TimeUnit.SECONDS))
        actor.submit(RuntimeIngressPriority.NORMAL, 1) { }
        return actor to release
    }

    val (telemetryActor, telemetryRelease) = saturatedActor()
    val telemetrySink = ProbeSink()
    val token = ChannelAuthenticator.generateToken()
    val telemetryIngress = CanonicalIngressCoordinator("COCOS_RUNTIME", telemetryActor, telemetrySink) { g, t ->
        g == 1L && ChannelAuthenticator.constantTimeSameToken(token, t)
    }
    val heartbeat = cocosBytes("HEARTBEAT", "EVT-DROP", 1, linkedMapOf(
        "runtimeState" to "RUNNING", "activeElapsedMs" to 1L, "clockRevision" to 1L, "lastAppliedControllerSeq" to 1L,
    ))
    telemetryIngress.submitInline("HEARTBEAT", "EVT-DROP", 1, heartbeat, sha256(heartbeat), 1L, token)
    check(telemetrySink.droppedLatch.await(1, TimeUnit.SECONDS))
    check(telemetrySink.dropped == listOf("EVT-DROP:HEARTBEAT"))
    telemetryRelease.countDown(); telemetryIngress.close(); telemetryActor.shutdownNow()

    val (criticalActor, criticalRelease) = saturatedActor()
    val criticalSink = ProbeSink()
    val criticalToken = ChannelAuthenticator.generateToken()
    val criticalIngress = CanonicalIngressCoordinator("ANDROID_CONTROLLER", criticalActor, criticalSink) { g, t ->
        g == 1L && ChannelAuthenticator.constantTimeSameToken(criticalToken, t)
    }
    val prepare = prepareBytes(messageId = "CMD-NONDROPPABLE")
    check(runCatching {
        criticalIngress.submitInline("PREPARE", "CMD-NONDROPPABLE", 1, prepare, sha256(prepare), 1L, criticalToken)
    }.exceptionOrNull() is RejectedExecutionException)
    check(criticalSink.fatalLatch.await(1, TimeUnit.SECONDS))
    criticalRelease.countDown(); criticalIngress.close(); criticalActor.shutdownNow()
}

private class FakeTrainingBinder : ITrainingRuntime.Stub() {
    @Volatile var callback: ITrainingRuntimeCallback? = null
    override fun registerCallback(newCallback: ITrainingRuntimeCallback, channelToken: String, generation: Long) { callback = newCallback }
    override fun submitInline(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, generation: Long) = Unit
    override fun submitBulk(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, generation: Long) = Unit
    override fun closeChannel(channelToken: String, generation: Long, reason: String) = Unit
}

private class BindingContext(private val service: IBinder) : Context() {
    val unbinds = AtomicInteger(0)
    override fun bindService(intent: Intent, connection: ServiceConnection, flags: Int): Boolean {
        connection.onServiceConnected(ComponentName(), service)
        return true
    }
    override fun unbindService(connection: ServiceConnection) { unbinds.incrementAndGet() }
}


private fun testControllerOwnedClosePersistsInterruptedOutcome() {
    val outcomes = Collections.synchronizedList(mutableListOf<String>())
    val client = ControllerRuntimeClient(BindingContext(FakeTrainingBinder()), "RUN-CLOSE", 3L, object : ExecutionOutcomeWriter {
        override fun recordInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long) {
            outcomes += "$runtimeSessionId:$executionAttempt:$reason"
        }
    })
    check(client.bind())
    client.close("CONTROLLER_RELEASED_EXECUTION")
    check(outcomes == listOf("RUN-CLOSE:3:CONTROLLER_RELEASED_EXECUTION"))
    client.close("DUPLICATE_CLOSE")
    check(outcomes.size == 1)
}

private fun testBinderDeathPersistsInterruptedAndRequiresFreshAttempt() {
    val binder = FakeTrainingBinder()
    val context = BindingContext(binder)
    val outcomeLatch = CountDownLatch(1)
    val outcomes = Collections.synchronizedList(mutableListOf<String>())
    val client = ControllerRuntimeClient(context, "RUN-DEATH-1", 1L, object : ExecutionOutcomeWriter {
        override fun recordInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long) {
            outcomes += "$runtimeSessionId:$executionAttempt:$reason"; outcomeLatch.countDown()
        }
    })
    check(client.bind())
    binder.killForTest()
    check(outcomeLatch.await(2, TimeUnit.SECONDS))
    check(outcomes.single().contains("TRAINING_PROCESS_DIED"))
    check(runCatching { client.bind() }.exceptionOrNull()?.message?.contains("new execution attempt") == true)
    client.close("TEST_DONE")

    val fresh = ControllerRuntimeClient(BindingContext(FakeTrainingBinder()), "RUN-DEATH-2", 2L, object : ExecutionOutcomeWriter {
        override fun recordInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long) = Unit
    })
    check(fresh.bind())
    fresh.close("TEST_DONE")
}

private fun testActualServiceAidlMockLoop() {
    Binder.setCallingUidForTest(1000)
    val service = TrainingRuntimeService()
    val runtime = ITrainingRuntime.Stub.asInterface(requireNotNull(service.onBind(null)))
    val token = ChannelAuthenticator.generateToken()
    val events = Collections.synchronizedList(mutableListOf<Pair<RuntimeWireEnvelope, ByteArray>>())
    val resultLatch = CountDownLatch(1)
    val interruptions = Collections.synchronizedList(mutableListOf<String>())
    val callback = object : ITrainingRuntimeCallback.Stub() {
        override fun onInlineEvent(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, channelGeneration: Long) {
            check(channelToken == token && channelGeneration == 1L && sha256(canonicalJson) == canonicalSha256)
            val event = envelope(canonicalJson, "COCOS_RUNTIME")
            events += event to canonicalJson.copyOf()
            if (event.messageType == "RESULT_READY") resultLatch.countDown()
        }
        override fun onBulkEvent(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, channelGeneration: Long) {
            val bytes = readExactly(payloadFd, byteLength)
            check(sha256(bytes) == canonicalSha256)
            val event = envelope(bytes, "COCOS_RUNTIME")
            events += event to bytes
            if (event.messageType == "RESULT_READY") resultLatch.countDown()
        }
        override fun onRuntimeInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long, channelToken: String, channelGeneration: Long) {
            interruptions += "$runtimeSessionId:$executionAttempt:$reason"
        }
    }
    runtime.registerCallback(callback, token, 1L)
    fun send(bytes: ByteArray) {
        val command = envelope(bytes, "ANDROID_CONTROLLER")
        runtime.submitInline(command.messageType, command.messageId, command.senderSeq, bytes, sha256(bytes), token, 1L)
    }
    send(prepareBytes()); send(startBytes()); send(pauseBytes()); send(resumeBytes()); send(deadlineBytes())
    check(resultLatch.await(4, TimeUnit.SECONDS))
    val types = events.map { it.first.messageType }
    check(types.first() == "READY")
    check(types.count { it == "BATCH_CLOSED" } == 8)
    check(types.last() == "RESULT_READY")
    val result = events.last().first
    send(ackBytes(result.payload.getValue("resultDraftSha256") as String))
    Thread.sleep(100)
    check(interruptions.isEmpty())

    val stale = runCatching {
        runtime.submitInline("QUERY_STATE", "CMD-STALE", 7, controllerBytes("QUERY_STATE", "CMD-STALE", 7, emptyMap()), "0".repeat(64), ChannelAuthenticator.generateToken(), 1L)
    }.exceptionOrNull()
    check(stale is SecurityException)
    service.onDestroy()
}


private fun testTrainingProcessDoesNotOwnControllerDatabase() {
    Application.setProcessNameForTest("com.a620.tablet:training")
    val application = A620Application()
    application.onCreate()
    check(!application.ownsPlatformControllerForTest())
    check(runCatching { application.platformController }.exceptionOrNull()
        ?.message?.contains("outside the APK main process") == true)
    application.onTerminate()
    Application.setProcessNameForTest("com.a620.tablet")
}


private fun testActualServiceChannelReplacementFencesOldRuntime() {
    Binder.setCallingUidForTest(1000)
    val service = TrainingRuntimeService()
    val runtime = ITrainingRuntime.Stub.asInterface(requireNotNull(service.onBind(null)))
    val firstToken = ChannelAuthenticator.generateToken()
    val secondToken = ChannelAuthenticator.generateToken()
    val firstReady = CountDownLatch(1)
    val firstInterrupted = CountDownLatch(1)
    val secondReady = CountDownLatch(1)

    val firstCallback = object : ITrainingRuntimeCallback.Stub() {
        override fun onInlineEvent(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, channelGeneration: Long) {
            check(channelToken == firstToken && channelGeneration == 1L)
            if (envelope(canonicalJson, "COCOS_RUNTIME").messageType == "READY") firstReady.countDown()
        }
        override fun onBulkEvent(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, channelGeneration: Long) = error("unexpected bulk event")
        override fun onRuntimeInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long, channelToken: String, channelGeneration: Long) {
            check(runtimeSessionId == "RUN-W1" && executionAttempt == 1L)
            check(reason == "CONTROLLER_CHANNEL_CLOSED:CHANNEL_REPLACED_BY_NEW_BINDING")
            check(channelToken == firstToken && channelGeneration == 1L)
            firstInterrupted.countDown()
        }
    }
    val secondCallback = object : ITrainingRuntimeCallback.Stub() {
        override fun onInlineEvent(messageType: String, messageId: String, senderSeq: Long, canonicalJson: ByteArray, canonicalSha256: String, channelToken: String, channelGeneration: Long) {
            check(channelToken == secondToken && channelGeneration == 2L)
            if (envelope(canonicalJson, "COCOS_RUNTIME").messageType == "READY") secondReady.countDown()
        }
        override fun onBulkEvent(messageType: String, messageId: String, senderSeq: Long, payloadFd: ParcelFileDescriptor, byteLength: Long, canonicalSha256: String, channelToken: String, channelGeneration: Long) = error("unexpected bulk event")
        override fun onRuntimeInterrupted(runtimeSessionId: String, executionAttempt: Long, reason: String, observedAtUptimeMs: Long, channelToken: String, channelGeneration: Long) = Unit
    }

    runtime.registerCallback(firstCallback, firstToken, 1L)
    val firstPrepare = prepareBytes()
    runtime.submitInline("PREPARE", "CMD-PREPARE", 1L, firstPrepare, sha256(firstPrepare), firstToken, 1L)
    check(firstReady.await(2, TimeUnit.SECONDS))

    runtime.registerCallback(secondCallback, secondToken, 2L)
    check(firstInterrupted.await(2, TimeUnit.SECONDS))
    val stale = runCatching {
        val query = controllerBytes("QUERY_STATE", "CMD-OLD-CHANNEL", 2L, emptyMap())
        runtime.submitInline("QUERY_STATE", "CMD-OLD-CHANNEL", 2L, query, sha256(query), firstToken, 1L)
    }.exceptionOrNull()
    check(stale is SecurityException)

    val secondPrepare = prepareBytes(messageId = "CMD-PREPARE-2", executionAttempt = 2L, runtimeSessionId = "RUN-W2")
    runtime.submitInline("PREPARE", "CMD-PREPARE-2", 1L, secondPrepare, sha256(secondPrepare), secondToken, 2L)
    check(secondReady.await(2, TimeUnit.SECONDS))
    service.onDestroy()
}

private fun testThreadAndDescriptorShutdown() {
    requireEventually("PFD gauge zero", 5_000) { ParcelFileDescriptor.activeDescriptorCountForTest() == 0 }
    requireEventually("Gate A/B worker shutdown", 5_000) {
        Thread.getAllStackTraces().keys.none { thread ->
            thread.isAlive && (
                thread.name.startsWith("a620-bulk-") ||
                    thread.name.startsWith("a620-controller-bulk-") ||
                    thread.name == "a620-reserved-lane-runtime"
            )
        }
    }
}

fun main() {
    testTrainingProcessDoesNotOwnControllerDatabase()
    testMockGameCommonPayloadForZeroOneSevenEight()
    testMockRuntimePauseResumeDeadlineRetryAndAck()
    testControllerToRuntimeInlineAndPfdTransport()
    testControllerPfdWriteFailureFailsClosed()
    testRuntimeToControllerPfdTransport()
    testOldPfdLateAfterRotationTimeoutAndShortRead()
    testBackpressureDropsOnlyTelemetryAndFailsClosedOtherwise()
    testControllerOwnedClosePersistsInterruptedOutcome()
    testBinderDeathPersistsInterruptedAndRequiresFreshAttempt()
    testActualServiceAidlMockLoop()
    testActualServiceChannelReplacementFencesOldRuntime()
    testThreadAndDescriptorShutdown()
    println("PLATFORM_GATEAB_DEVICE_SHELL_JVM_STUB_TESTS_PASS")
}
