package a620.shell

import a620.BatchEvidence
import a620.CanonicalJson

enum class MockSessionState {
    READY, RUNNING, PAUSED, FINALIZING, RESULT_READY, RESULT_COMMITTED, INTERRUPTED
}

data class MockBatch(
    val ordinal: Int,
    val levelBefore: Int,
    val resultZone: String,
    val levelTransition: String,
    val levelAfter: Int,
    val batchScore: Int,
    val closedAtActiveMs: Int,
    val payload: Map<String, Any?>,
    val payloadSha256: String,
)

data class MockResultDraft(
    val runtimeSessionId: String,
    val executionAttempt: Long,
    val payload: Map<String, Any?>,
    val payloadSha256: String,
    val batches: List<MockBatch>,
)

/**
 * Engine-free deterministic game used to prove the controller/runtime loop.
 * It models eight 37.5-second batches whose decision point occurs at 35 s,
 * leaving a 2.5-second transition before the next batch.
 */
class MockGameSession(
    val runtimeSessionId: String,
    val executionAttempt: Long,
    val sessionStartLevel: Int,
    private val plannedBatchCount: Int = 8,
) {
    var state: MockSessionState = MockSessionState.READY
        private set
    var activeElapsedMs: Int = 0
        private set
    private var currentLevel: Int = sessionStartLevel
    private val batches = mutableListOf<MockBatch>()

    init {
        require(runtimeSessionId.isNotBlank())
        require(executionAttempt >= 1)
        require(sessionStartLevel >= 1)
        require(plannedBatchCount == 8) { "MockGame is fixed to eight batches" }
    }

    fun start() {
        check(state == MockSessionState.READY)
        state = MockSessionState.RUNNING
    }

    fun pause() {
        check(state == MockSessionState.RUNNING)
        state = MockSessionState.PAUSED
    }

    fun resume() {
        check(state == MockSessionState.PAUSED)
        state = MockSessionState.RUNNING
    }

    fun advanceActiveBy(deltaMs: Int): List<MockBatch> {
        require(deltaMs >= 0)
        check(state == MockSessionState.RUNNING) { "active time advances only while RUNNING" }
        val target = minOf(300_000, activeElapsedMs + deltaMs)
        val newlyClosed = mutableListOf<MockBatch>()
        while (batches.size < plannedBatchCount) {
            val ordinal = batches.size + 1
            val closesAt = 35_000 + (ordinal - 1) * 37_500
            if (closesAt > target || closesAt >= 300_000) break
            val batch = closeBatch(ordinal, closesAt)
            batches += batch
            newlyClosed += batch
        }
        activeElapsedMs = target
        if (activeElapsedMs == 300_000) {
            state = MockSessionState.FINALIZING
        }
        return newlyClosed
    }

    /** Apply the authoritative deadline without completing a pending batch. */
    fun applyDeadline() {
        check(state == MockSessionState.RUNNING || state == MockSessionState.PAUSED)
        activeElapsedMs = 300_000
        state = MockSessionState.FINALIZING
    }

    fun buildResultDraft(): MockResultDraft {
        check(state == MockSessionState.FINALIZING || state == MockSessionState.RESULT_READY)
        val eligible = batches.map { it.payload + mapOf("batchPayloadSha256" to it.payloadSha256) }
        val incompleteAudit: List<Map<String, Any?>> = if (batches.size < plannedBatchCount) {
            val ordinal = batches.size + 1
            listOf(
                linkedMapOf(
                    "batchOrdinal" to ordinal,
                    "levelBefore" to currentLevel,
                    "cutoffReason" to "DEADLINE",
                    "startedAtActiveMs" to ((ordinal - 1) * 37_500),
                    "cutoffAtActiveMs" to 300_000,
                )
            )
        } else emptyList()
        val score = batches.sumOf { it.batchScore }
        val highestPresented = batches.maxOfOrNull { it.levelBefore } ?: sessionStartLevel
        val highestPassed = batches
            .filter { it.resultZone == "UPGRADE" }
            .maxOfOrNull { it.levelBefore }
        val payload = linkedMapOf<String, Any?>(
            "gameCode" to "MOCK_GAME",
            "plannedBatchCount" to plannedBatchCount,
            "eligibleBatchCount" to batches.size,
            "eligibleBatches" to eligible,
            "incompleteBatchAudit" to incompleteAudit,
            "sessionStartLevel" to sessionStartLevel,
            "sessionEndLevel" to currentLevel,
            "sessionHighestPresentedLevel" to highestPresented,
            "sessionHighestPassedLevel" to highestPassed,
            "nextStartLevel" to currentLevel,
            "sessionRawScore" to score,
            "sessionRawScoreMax" to 800,
            "activeElapsedMs" to activeElapsedMs,
        )
        state = MockSessionState.RESULT_READY
        return MockResultDraft(
            runtimeSessionId = runtimeSessionId,
            executionAttempt = executionAttempt,
            payload = payload,
            payloadSha256 = CanonicalJson.sha256(payload),
            batches = batches.toList(),
        )
    }

    fun markCommitted() {
        check(state == MockSessionState.RESULT_READY || state == MockSessionState.RESULT_COMMITTED)
        state = MockSessionState.RESULT_COMMITTED
    }

    fun interrupt(reason: String) {
        require(reason.isNotBlank())
        check(state != MockSessionState.RESULT_COMMITTED)
        state = MockSessionState.INTERRUPTED
    }

    fun closedBatches(): List<MockBatch> = batches.toList()

    private fun closeBatch(ordinal: Int, closedAt: Int): MockBatch {
        val levelBefore = currentLevel
        val score = 80 + ordinal
        val levelAfter = currentLevel + 1
        currentLevel = levelAfter
        val payload = linkedMapOf<String, Any?>(
            "batchOrdinal" to ordinal,
            "closed" to true,
            "decisionEligible" to true,
            "levelBefore" to levelBefore,
            "resultZone" to "UPGRADE",
            "levelTransition" to "UP",
            "levelAfter" to levelAfter,
            "batchScore" to score,
            "closedAtActiveMs" to closedAt,
            "gameBatchMetrics" to mapOf("mockHits" to 10, "mockDistractors" to 0),
        )
        return MockBatch(
            ordinal = ordinal,
            levelBefore = levelBefore,
            resultZone = "UPGRADE",
            levelTransition = "UP",
            levelAfter = levelAfter,
            batchScore = score,
            closedAtActiveMs = closedAt,
            payload = payload,
            payloadSha256 = CanonicalJson.sha256(payload),
        )
    }

    fun evidence(messagePrefix: String = "BATCH"): List<BatchEvidence> = batches.map {
        BatchEvidence(
            batchOrdinal = it.ordinal,
            batchPayloadSha256 = it.payloadSha256,
            closedAtActiveMs = it.closedAtActiveMs,
            messageId = "$messagePrefix-${it.ordinal}",
            senderSeq = it.ordinal.toLong(),
            receivedAtUptimeMs = it.closedAtActiveMs.toLong(),
        )
    }
}
