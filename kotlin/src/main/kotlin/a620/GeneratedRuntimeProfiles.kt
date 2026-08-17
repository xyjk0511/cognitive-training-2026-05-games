// Generated from contracts/normative A620 runtime profiles.
// Do not edit by hand; run scripts/bootstrap_vectors.sh.
package a620

object GeneratedRuntimeProfiles {
    const val JsonMaxDepth: Int = 64
    const val JsonMaxTotalNodes: Int = 50000
    const val JsonMaxObjectMembers: Int = 2048
    const val JsonMaxArrayItems: Int = 2048
    const val JsonMaxStringUtf8Bytes: Int = 262144
    const val JsonMaxObjectKeyUtf8Bytes: Int = 512
    const val JsonMaxTotalStringUtf8Bytes: Int = 1572864
    const val IpcFrameHeaderBytes: Int = 4
    const val IpcFrameMinPayloadBytes: Int = 2
    const val IpcFrameMaxPayloadBytes: Int = 2097152
    const val IpcFrameMaxFeedChunkBytes: Int = 8388608
    val DeliveryRetryDelaysMs = longArrayOf(100L, 250L, 500L, 1000L, 2000L, 5000L)
    const val DeliveryRetryCapMs: Int = 5000
    const val DeliveryMaxSeenMessageIdsPerRuntime: Int = 2048
    const val DeliveryMaxPendingPerRuntime: Int = 4096
    const val DeliveryMaxPendingBytesPerRuntime: Int = 16777216
    val DeliveryResponseObligations: Map<String, List<String>> = mapOf("PREPARE" to listOf("READY"), "START" to listOf("COMMAND_ACCEPTED", "STARTED"), "PAUSE" to listOf("COMMAND_ACCEPTED", "PAUSED"), "RESUME" to listOf("COMMAND_ACCEPTED", "RESUMED"), "TERMINATE" to listOf("COMMAND_ACCEPTED", "TERMINATED"), "QUERY_STATE" to listOf("STATE_SNAPSHOT"), "RESULT_READY" to listOf("ACK_RESULT_COMMITTED"))
    val DeliveryRetainUntilResultCommitted: List<String> = listOf("BATCH_CLOSED")
    val WatchdogTimeoutsMs: Map<String, Long> = mapOf("prepareReady" to 10000L, "commandAccepted" to 100L, "startConfirmationAfterBoundary" to 1000L, "pauseConfirmationAfterBoundary" to 1000L, "resumeConfirmationAfterBoundary" to 1000L, "terminateConfirmationAfterBoundary" to 1000L, "queryState" to 1000L, "heartbeatInterval" to 1000L, "heartbeatSilence" to 3500L, "finalizationResultReady" to 5000L, "localResultCommit" to 5000L)
    const val WatchdogSnapshotVersion: String = "A620-RWS-1.1"
    const val AuditChainProfileId: String = "A620-RAC-1"
    const val AuditChainGenesisSha256: String = "0000000000000000000000000000000000000000000000000000000000000000"
    val AuditChainEntryProjection: List<String> = listOf("auditProfile", "journalIndex", "messageId", "runtimeSessionId", "senderRole", "senderSeq", "sentAtUptimeMs", "canonicalSha256", "disposition", "previousEntrySha256")
    const val AuditChainMigrationKey: String = "runtimeAuditChainProfile"
    const val AuditChainMigrationValue: String = "A620-RAC-1"
}
