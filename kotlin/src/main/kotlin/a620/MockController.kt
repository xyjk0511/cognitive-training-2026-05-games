package a620

class BatchEvidenceLedger(private val plannedBatchCount: Int) {
    private val entries = linkedMapOf<Int, BatchEvidence>()
    fun record(evidence: BatchEvidence) {
        require(evidence.batchOrdinal in 1..plannedBatchCount)
        require(evidence.batchOrdinal !in entries) { "duplicate batch ordinal" }
        require(entries.isEmpty() || evidence.batchOrdinal == entries.keys.max() + 1) { "batch ordinal is not contiguous" }
        entries[evidence.batchOrdinal] = evidence
    }
    fun reconcile(finalHashes: Map<Int, String>) {
        require(entries.keys == finalHashes.keys) { "final batch set differs from evidence ledger" }
        entries.forEach { (ordinal, evidence) -> require(finalHashes[ordinal] == evidence.batchPayloadSha256) { "batch $ordinal hash mismatch" } }
    }
}

class MockController {
    var state: RuntimeState = RuntimeState.UNPREPARED
        private set
    fun apply(input: RuntimeInput) { state = RuntimeStateMachine.reduce(state, input) }
}
