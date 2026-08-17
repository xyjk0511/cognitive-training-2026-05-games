package a620.shell

import a620.BatchEvidenceLedger

data class CommitAck(
    val resultId: String,
    val resultPayloadSha256: String,
    val committedAtUptimeMs: Long,
)

data class ExecutionOutcomeRecord(
    val runtimeSessionId: String,
    val executionAttempt: Long,
    val completionState: String,
    val reason: String,
    val observedAtUptimeMs: Long,
)

/**
 * In-memory reference for the Android transaction boundary. Room must preserve
 * the same uniqueness and result/outcome mutual exclusion semantics.
 */
class MockAndroidController {
    private data class SessionRecord(
        val game: MockGameSession,
        val channelGeneration: Long,
        var committed: CommitAck? = null,
        var committedPayloadSha256: String? = null,
        var outcome: ExecutionOutcomeRecord? = null,
    )

    private val channel = RuntimeChannel()
    private val sessions = linkedMapOf<String, SessionRecord>()
    private val latestAttemptByTaskItem = linkedMapOf<String, Long>()
    private var nextRuntimeNumber = 1
    private var nextResultNumber = 1

    fun createSession(taskItemId: String, executionAttempt: Long, startLevel: Int): MockGameSession {
        require(taskItemId.isNotBlank())
        val previous = latestAttemptByTaskItem[taskItemId]
        require(previous == null || executionAttempt > previous) { "executionAttempt must increase" }
        latestAttemptByTaskItem[taskItemId] = executionAttempt
        val runtimeSessionId = "RUN-${nextRuntimeNumber++}"
        val generation = channel.connect(runtimeSessionId, executionAttempt)
        channel.registerCallback(generation)
        val game = MockGameSession(runtimeSessionId, executionAttempt, startLevel)
        sessions[runtimeSessionId] = SessionRecord(game, generation)
        return game
    }

    fun commit(draft: MockResultDraft, committedAtUptimeMs: Long): CommitAck {
        val record = requireNotNull(sessions[draft.runtimeSessionId]) { "unknown runtime" }
        require(record.outcome == null) { "interrupted runtime cannot form a formal result" }
        require(record.game.executionAttempt == draft.executionAttempt)
        record.committed?.let { existing ->
            require(record.committedPayloadSha256 == draft.payloadSha256) {
                "same runtime attempted a different result payload"
            }
            record.game.markCommitted()
            return existing
        }
        val ledger = BatchEvidenceLedger(8)
        record.game.evidence().forEach(ledger::record)
        ledger.reconcile(draft.batches.associate { it.ordinal to it.payloadSha256 })
        require(draft.payload["sessionRawScore"] == draft.batches.sumOf { it.batchScore })
        require(draft.payload["eligibleBatchCount"] == draft.batches.size)
        val ack = CommitAck(
            resultId = "RESULT-${nextResultNumber++}",
            resultPayloadSha256 = draft.payloadSha256,
            committedAtUptimeMs = committedAtUptimeMs,
        )
        record.committed = ack
        record.committedPayloadSha256 = draft.payloadSha256
        record.game.markCommitted()
        return ack
    }

    fun trainingProcessDied(runtimeSessionId: String, nowUptimeMs: Long): ExecutionOutcomeRecord {
        val record = requireNotNull(sessions[runtimeSessionId]) { "unknown runtime" }
        require(record.committed == null) { "committed result is already terminal" }
        record.outcome?.let { return it }
        val channelOutcome = channel.onBinderDeath(record.channelGeneration, nowUptimeMs)
        record.game.interrupt(channelOutcome.reason)
        return ExecutionOutcomeRecord(
            runtimeSessionId = runtimeSessionId,
            executionAttempt = record.game.executionAttempt,
            completionState = "INTERRUPTED",
            reason = channelOutcome.reason,
            observedAtUptimeMs = nowUptimeMs,
        ).also { record.outcome = it }
    }

    fun outcome(runtimeSessionId: String): ExecutionOutcomeRecord? = sessions[runtimeSessionId]?.outcome
}
