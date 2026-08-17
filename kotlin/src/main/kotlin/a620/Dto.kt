package a620

const val CONTRACT_VERSION = "A620-TRC-1.1"
const val CLOCK_PROFILE = "A620-UPTIME-MS-1"

enum class GameCode { CATCH_LIGHT, SIGNAL_STATION }

data class Identity(
    val systemId: String,
    val deviceId: String,
    val taskId: String,
    val taskItemId: String,
    val executionAttempt: Long,
    val runtimeSessionId: String,
    val packageVersion: String,
    val coreProtocolVersion: String,
    val monotonicEpochId: String,
)

data class MessageEnvelope<P>(
    val contractVersion: String = CONTRACT_VERSION,
    val messageType: String,
    val messageId: String,
    val correlationId: String?,
    val senderRole: String,
    val senderSeq: Long,
    val sentAtUtc: String,
    val sentAtUptimeMs: Long,
    val identity: Identity,
    val payload: P,
)

data class BatchEvidence(
    val batchOrdinal: Int,
    val batchPayloadSha256: String,
    val closedAtActiveMs: Int,
    val messageId: String,
    val senderSeq: Long,
    val receivedAtUptimeMs: Long,
)

data class IncompleteBatchAudit(
    val batchOrdinal: Int,
    val levelBefore: Int,
    val cutoffReason: String = "DEADLINE",
    val startedAtActiveMs: Int,
    val cutoffAtActiveMs: Int = 300_000,
)
