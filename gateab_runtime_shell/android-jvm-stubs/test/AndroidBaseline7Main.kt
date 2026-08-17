package com.a620.tablet.training

import android.view.MotionEvent
import a620.CanonicalJson
import a620.RuntimeWireEnvelope
import a620.shell.PointerGateDecision
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
    @Volatile var lastEnvelope: RuntimeWireEnvelope? = null
    @Volatile var lastViolation: String? = null

    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        lastEnvelope = envelope
        valid.countDown()
    }
    override fun onProtocolViolation(messageId: String?, reason: String) {
        lastViolation = "$messageId:$reason"
        invalid.countDown()
    }
    override fun onTelemetryDropped(messageId: String, messageType: String) = Unit
    override fun onFatalInfrastructureFailure(reason: String) = error(reason)
    override fun onControllerChannelClosed(reason: String) = Unit
}

private fun canonicalMessage(messageId: String, senderSeq: Long): ByteArray = CanonicalJson.canonicalBytes(
    linkedMapOf(
        "contractVersion" to "A620-TRC-1.1",
        "messageType" to "PREPARE",
        "messageId" to messageId,
        "correlationId" to null,
        "senderRole" to "ANDROID_CONTROLLER",
        "senderSeq" to senderSeq,
        "sentAtUtc" to "2026-08-18T00:00:00Z",
        "sentAtUptimeMs" to 100L,
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
    val coordinator = CanonicalIngressCoordinator("ANDROID_CONTROLLER", actor, sink) { generation ->
        check(generation == 1L)
    }
    val good = canonicalMessage("MSG-1", 1)
    coordinator.submitInline("PREPARE", "MSG-1", 1, good, sha256(good), 1)
    check(sink.valid.await(2, TimeUnit.SECONDS))
    check(sink.lastEnvelope?.messageId == "MSG-1")

    val bad = canonicalMessage("MSG-2", 2)
    coordinator.submitInline("PAUSE", "MSG-2", 2, bad, sha256(bad), 1)
    check(sink.invalid.await(2, TimeUnit.SECONDS))
    check(sink.lastViolation?.contains("AIDL messageType differs") == true)
    coordinator.close()
    actor.shutdownNow()
}

fun main() {
    testTouchCancellation()
    testStrictInlineIngress()
    println("ANDROID_STUB_BASELINE7_INGRESS_AND_TOUCH_TEST_PASS")
}
