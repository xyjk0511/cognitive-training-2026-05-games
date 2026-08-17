// generated; do not edit
package a620.shell

/** Compatibility view over A620-ARS-1. */
object AndroidShellProfile {
    const val Profile = "A620-ARS-1"
    const val CandidateRevision = "rc3-baseline.6"
    const val WireContractVersion = "A620-TRC-1.1"
    const val Status = "GATE_AB_RUNTIME_SHELL_CANDIDATE_NOT_DEVICE_APPROVED"
    const val ProfileSha256 = "f9fa8a11b7bbb31d0732a5746145be9eb13755d45d406d0abd0e3c148cd9f8e7"

    const val InlineCanonicalMaxBytes = 49152
    const val InlineDescriptorMaxBytes = 8192
    const val BulkCanonicalMaxBytes = 2097152
    const val BulkLeaseMs = 15000L
    const val ActorQueueMaxMessages = 256
    const val ActorQueueMaxBytes = 4194304
    const val SameUidRequired = true
    const val OnewaySubmission = true
    const val DuplicateFdBeforeAsyncUse = true

    const val InputClockProfile = "A620-UPTIME-MS-1"
    const val InputInterval = "HALF_OPEN"
    const val MaxPointers = 10
    const val RejectUnknownPointerUp = true

    const val TrainingProcessSuffix = ":training"
    const val ServiceExported = false
    const val AutoResumeAfterProcessDeath = false
    const val DeathOutcome = "INTERRUPTED"
    const val NewExecutionAttemptRequiredAfterDeath = true
    const val CallbackRegistrationTimeoutMs = 5000L
}
