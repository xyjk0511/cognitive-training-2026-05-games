package a620.shell

import a620.shell.generated.RuntimeShellProfiles as P

import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

private fun checkTrue(value: Boolean, message: String) {
    check(value) { message }
}

private inline fun <reified T : Throwable> expectThrows(noinline block: () -> Unit) {
    try {
        block()
        error("expected ${T::class.simpleName}")
    } catch (error: Throwable) {
        if (error !is T) throw error
    }
}

private fun testGeneratedProfile() {
    checkTrue(P.ANDROID_SHELL_PROFILE == "A620-ARS-1", "profile")
    checkTrue(P.CANDIDATE_REVISION == "rc3-baseline.6", "revision")
    checkTrue(P.WIRE_CONTRACT_VERSION == "A620-TRC-1.1", "wire contract")
    checkTrue(P.INLINE_CANONICAL_MAX_BYTES < 1_000_000, "Binder inline limit must remain conservative")
    checkTrue(!P.AUTO_RESUME_AFTER_PROCESS_DEATH, "no mid-session auto-resume")
}

private fun testTransportSplit() {
    val root = Files.createTempDirectory("a620-bulk-test")
    val store = BulkPayloadStore(root)
    val planner = TransportPlanner(store)

    val small = "{\"type\":\"PING\"}".encodeToByteArray()
    val inline = planner.plan(small, 100)
    checkTrue(inline.kind == TransportKind.INLINE, "small payload must be inline")
    checkTrue(inline.inlineCanonical!!.contentEquals(small), "inline bytes")

    val large = ByteArray(P.INLINE_CANONICAL_MAX_BYTES + 1) { (it % 251).toByte() }
    val bulk = planner.plan(large, 1_000, "payload-a")
    checkTrue(bulk.kind == TransportKind.BULK_FD, "large payload must use bulk transport")
    checkTrue(store.verifyAndRead(bulk.bulk!!, 1_001).contentEquals(large), "bulk round trip")

    val tamper = planner.plan(large, 2_000, "payload-b").bulk!!
    Files.write(root.resolve("payload-b.payload"), large.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() })
    expectThrows<IllegalArgumentException> { store.verifyAndRead(tamper, 2_001) }

    val expired = planner.plan(large, 3_000, "payload-c").bulk!!
    expectThrows<IllegalArgumentException> {
        store.verifyAndRead(expired, expired.expiresAtUptimeMs + 1)
    }

    expectThrows<IllegalArgumentException> {
        planner.plan(ByteArray(P.BULK_CANONICAL_MAX_BYTES + 1), 0)
    }
    root.toFile().deleteRecursively()
}

private fun testSingleConsumerActor() {
    val actor = BoundedRuntimeActor<Int>()
    val start = CountDownLatch(1)
    val finished = CountDownLatch(4)
    repeat(4) { worker ->
        thread(name = "submit-$worker") {
            start.await()
            repeat(50) { index ->
                actor.submit("M-$worker-$index", 100, worker * 100 + index)
            }
            finished.countDown()
        }
    }
    start.countDown()
    finished.await()
    checkTrue(actor.queuedMessageCount() == 200, "actor queue size")
    val ingress = Collections.synchronizedList(mutableListOf<Long>())
    val drained = actor.drain { ingress += it.ingressSeq }
    checkTrue(drained == 200, "drain count")
    checkTrue(ingress == (1L..200L).toList(), "single deterministic ingress order")
    checkTrue(actor.queuedCanonicalBytes() == 0, "byte budget released")

    repeat(P.ACTOR_QUEUE_MAX_MESSAGES) {
        actor.submit("FULL-$it", 1, it)
    }
    expectThrows<ActorBackpressure> { actor.submit("OVER", 1, 0) }
    actor.drain { }
}

private fun testHalfOpenInputGate() {
    val gate = UptimeInputGate()
    gate.configure(1_000, 2_000)
    checkTrue(!gate.onPointer(0, PointerAction.DOWN, 999).accepted, "before window")
    checkTrue(gate.onPointer(0, PointerAction.DOWN, 1_000).accepted, "start inclusive")
    checkTrue(gate.onPointer(0, PointerAction.MOVE, 1_999).accepted, "end minus one")
    checkTrue(!gate.onPointer(0, PointerAction.UP, 2_000).accepted, "end exclusive")
    checkTrue(gate.activePointerCount() == 0, "late up still cleans pointer")
    checkTrue(!gate.onPointer(8, PointerAction.UP, 1_500).accepted, "unknown up")
}

private fun testMockGameFullLoop() {
    val controller = MockAndroidController()
    val game = controller.createSession("ITEM-1", 1, 1)
    game.start()
    game.advanceActiveBy(40_000)
    checkTrue(game.closedBatches().size == 1, "first batch closes")
    game.pause()
    expectThrows<IllegalStateException> { game.advanceActiveBy(1) }
    game.resume()
    game.advanceActiveBy(260_000)
    checkTrue(game.state == MockSessionState.FINALIZING, "deadline finalizes")
    checkTrue(game.closedBatches().size == 8, "all eight batches close before deadline")
    val draft = game.buildResultDraft()
    checkTrue(draft.payload["sessionRawScore"] == 676, "deterministic raw score")
    val ack1 = controller.commit(draft, 310_000)
    val ack2 = controller.commit(draft, 999_999)
    checkTrue(ack1 == ack2, "commit retry returns first fact")
    checkTrue(game.state == MockSessionState.RESULT_COMMITTED, "commit terminal")
}


private fun testPartialDeadlineResults() {
    val closeTimes = mapOf(0 to 0, 1 to 35_000, 7 to 260_000)
    for ((expectedCount, advanceTo) in closeTimes) {
        val controller = MockAndroidController()
        val game = controller.createSession("PARTIAL-$expectedCount", 1, 10)
        game.start()
        if (advanceTo > 0) game.advanceActiveBy(advanceTo)
        game.applyDeadline()
        val draft = game.buildResultDraft()
        checkTrue(draft.batches.size == expectedCount, "partial batch count $expectedCount")
        checkTrue(draft.payload["eligibleBatchCount"] == expectedCount, "payload count $expectedCount")
        checkTrue(draft.payload["nextStartLevel"] == 10 + expectedCount, "next level $expectedCount")
        checkTrue((draft.payload["incompleteBatchAudit"] as List<*>).size == 1, "deadline audit $expectedCount")
        controller.commit(draft, 300_001)
    }
}

private fun testProcessDeathAndNewAttempt() {
    val controller = MockAndroidController()
    val old = controller.createSession("ITEM-X", 1, 5)
    old.start()
    old.advanceActiveBy(50_000)
    val outcome = controller.trainingProcessDied(old.runtimeSessionId, 60_000)
    checkTrue(outcome.completionState == "INTERRUPTED", "death outcome")
    checkTrue(old.state == MockSessionState.INTERRUPTED, "old game interrupted")
    checkTrue(controller.outcome(old.runtimeSessionId) == outcome, "outcome persisted")
    expectThrows<IllegalStateException> { old.buildResultDraft() }
    expectThrows<IllegalArgumentException> { controller.createSession("ITEM-X", 1, 5) }
    val fresh = controller.createSession("ITEM-X", 2, 5)
    checkTrue(fresh.executionAttempt == 2L, "new attempt required")
}

fun main() {
    testGeneratedProfile()
    testTransportSplit()
    testSingleConsumerActor()
    testHalfOpenInputGate()
    testMockGameFullLoop()
    testPartialDeadlineResults()
    testProcessDeathAndNewAttempt()
    println("KOTLIN_BASELINE6_RUNTIME_SHELL_TESTS_PASS")
}
