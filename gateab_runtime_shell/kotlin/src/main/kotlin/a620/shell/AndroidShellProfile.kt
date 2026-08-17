// generated; do not edit
package a620.shell

/** Compatibility view over A620-ARS-1. */
object AndroidShellProfile {
    const val Profile = "A620-ARS-1"
    const val CandidateRevision = "rc3-baseline.7"
    const val WireContractVersion = "A620-TRC-1.1"
    const val Status = "GATE_AB_RUNTIME_INGRESS_CANDIDATE_NOT_DEVICE_APPROVED"
    const val ProfileSha256 = "ad5f742e1ec5b61f970737d117264e4194d7c907fe4d335d6031d6ba065d86a5"

    const val InlineCanonicalMaxBytes = 49152
    const val InlineDescriptorMaxBytes = 8192
    const val BulkCanonicalMaxBytes = 2097152
    const val BulkLeaseMs = 15000L
    const val ActorQueueMaxMessages = 96
    const val ActorQueueMaxBytes = 5242880
    const val UrgentQueueMaxMessages = 32
    const val UrgentQueueMaxBytes = 4194304
    const val NormalQueueMaxMessages = 64
    const val NormalQueueMaxBytes = 1048576
    const val PreserveIngressOrderAcrossReservedLanes = true
    const val BulkIoWorkers = 2
    const val BulkIoQueueMaxMessages = 4
    const val MaxInflightBulkMessages = 4
    const val MaxInflightBulkBytes = 4194304
    const val BulkReadTimeoutMs = 15000L
    const val StrictCanonicalEnvelopeRequired = true
    const val CompareAidlIdentityToEnvelope = true
    val UrgentMessageTypes: Set<String> = setOf("TERMINATE","DEADLINE","PAUSE","ACK_RESULT_COMMITTED","READY","STARTED","BATCH_CLOSED","PAUSED","RESUMED","RESULT_READY","TERMINATED","COMMAND_ACCEPTED","COMMAND_REJECTED","RUNTIME_ERROR")
    val DroppableOnBackpressureMessageTypes: Set<String> = setOf("HEARTBEAT","STATE_SNAPSHOT")
    const val SameUidRequired = true
    const val OnewaySubmission = true
    const val DuplicateFdBeforeAsyncUse = true

    const val InputClockProfile = "A620-UPTIME-MS-1"
    const val InputInterval = "HALF_OPEN"
    const val MaxPointers = 10
    const val RejectUnknownPointerUp = true
    const val CancelActiveStreamOnBoundary = true
    const val ForwardPlatformCancel = true

    const val TrainingProcessSuffix = ":training"
    const val ServiceExported = false
    const val AutoResumeAfterProcessDeath = false
    const val DeathOutcome = "INTERRUPTED"
    const val NewExecutionAttemptRequiredAfterDeath = true
    const val CallbackRegistrationTimeoutMs = 5000L
}
