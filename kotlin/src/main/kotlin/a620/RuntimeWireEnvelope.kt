package a620

private val A620_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
private val A620_SEMVER_PATTERN = Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$")

private val ANDROID_MESSAGE_TYPES = setOf(
    "PREPARE", "START", "PAUSE", "RESUME", "DEADLINE", "TERMINATE",
    "QUERY_STATE", "ACK_RESULT_COMMITTED",
)
private val COCOS_MESSAGE_TYPES = setOf(
    "READY", "STARTED", "BATCH_CLOSED", "PAUSED", "RESUMED", "STATE_SNAPSHOT",
    "RESULT_READY", "TERMINATED", "COMMAND_REJECTED", "RUNTIME_ERROR", "HEARTBEAT",
    "COMMAND_ACCEPTED",
)
private val ALL_MESSAGE_TYPES = ANDROID_MESSAGE_TYPES + COCOS_MESSAGE_TYPES

private val COMMON_ENVELOPE_FIELDS = setOf(
    "contractVersion", "messageType", "messageId", "correlationId", "senderRole", "senderSeq",
    "sentAtUtc", "sentAtUptimeMs", "monotonicEpochId", "systemId", "deviceId", "taskId",
    "taskItemId", "executionAttempt", "runtimeSessionId", "packageVersion", "coreProtocolVersion",
    "payload",
)

enum class RuntimeIngressPriority { URGENT, NORMAL }

data class RuntimeWireEnvelope(
    val contractVersion: String,
    val messageType: String,
    val messageId: String,
    val correlationId: String?,
    val senderRole: String,
    val senderSeq: Long,
    val sentAtUtc: String,
    val sentAtUptimeMs: Long,
    val monotonicEpochId: String,
    val systemId: String,
    val deviceId: String,
    val taskId: String,
    val taskItemId: String,
    val executionAttempt: Long,
    val runtimeSessionId: String,
    val packageVersion: String,
    val coreProtocolVersion: String,
    val payload: Map<String, Any?>,
)

object RuntimeWireEnvelopeParser {
    fun parseCanonical(
        canonicalBytes: ByteArray,
        declaredMessageType: String? = null,
        declaredMessageId: String? = null,
        declaredSenderSeq: Long? = null,
        expectedSenderRole: String? = null,
    ): RuntimeWireEnvelope {
        val root = StrictCanonicalJson.parse(canonicalBytes)
        val map = root as? Map<*, *> ?: error("runtime wire message must be an object")
        val stringMap = LinkedHashMap<String, Any?>()
        for ((key, value) in map) {
            require(key is String) { "runtime wire key must be string" }
            stringMap[key] = value
        }
        require(stringMap.keys == COMMON_ENVELOPE_FIELDS) {
            val missing = COMMON_ENVELOPE_FIELDS - stringMap.keys
            val extra = stringMap.keys - COMMON_ENVELOPE_FIELDS
            "runtime envelope fields mismatch; missing=$missing extra=$extra"
        }

        fun requiredString(name: String): String =
            (stringMap[name] as? String)?.also { require(it.isNotEmpty()) { "$name must not be empty" } }
                ?: error("$name must be string")
        fun id(name: String): String = requiredString(name).also {
            require(A620_ID_PATTERN.matches(it)) { "$name has invalid identifier syntax" }
        }
        fun safeLong(name: String, minimum: Long): Long = (stringMap[name] as? Long)?.also {
            require(it in minimum..CanonicalJson.SAFE_INTEGER_MAX) { "$name out of range" }
        } ?: error("$name must be integer")

        val contractVersion = requiredString("contractVersion")
        require(contractVersion == CONTRACT_VERSION) { "unsupported contractVersion" }
        val messageType = requiredString("messageType")
        require(messageType in ALL_MESSAGE_TYPES) { "unknown messageType: $messageType" }
        val messageId = id("messageId")
        val correlation = when (val raw = stringMap["correlationId"]) {
            null -> null
            is String -> raw.also { require(A620_ID_PATTERN.matches(it)) { "invalid correlationId" } }
            else -> error("correlationId must be string or null")
        }
        val senderRole = requiredString("senderRole")
        val requiredRole = if (messageType in ANDROID_MESSAGE_TYPES) "ANDROID_CONTROLLER" else "COCOS_RUNTIME"
        require(senderRole == requiredRole) { "$messageType must be sent by $requiredRole" }
        expectedSenderRole?.let { require(senderRole == it) { "unexpected senderRole" } }
        val senderSeq = safeLong("senderSeq", 1)
        val sentAtUtc = requiredString("sentAtUtc")
        require(sentAtUtc.length in 20..64 && sentAtUtc.endsWith("Z")) { "sentAtUtc must be bounded UTC date-time" }
        val sentAtUptimeMs = safeLong("sentAtUptimeMs", 0)
        val monotonicEpochId = id("monotonicEpochId")
        val systemId = id("systemId")
        val deviceId = id("deviceId")
        val taskId = id("taskId")
        val taskItemId = id("taskItemId")
        val executionAttempt = safeLong("executionAttempt", 1)
        val runtimeSessionId = id("runtimeSessionId")
        val packageVersion = requiredString("packageVersion").also {
            require(A620_SEMVER_PATTERN.matches(it)) { "packageVersion is not SemVer" }
        }
        val coreProtocolVersion = requiredString("coreProtocolVersion").also {
            require(it.length <= 128) { "coreProtocolVersion too long" }
        }
        val rawPayload = stringMap["payload"] as? Map<*, *> ?: error("payload must be object")
        val payload = LinkedHashMap<String, Any?>()
        for ((key, value) in rawPayload) {
            require(key is String) { "payload key must be string" }
            payload[key] = value
        }

        declaredMessageType?.let { require(messageType == it) { "AIDL messageType differs from canonical envelope" } }
        declaredMessageId?.let { require(messageId == it) { "AIDL messageId differs from canonical envelope" } }
        declaredSenderSeq?.let { require(senderSeq == it) { "AIDL senderSeq differs from canonical envelope" } }

        return RuntimeWireEnvelope(
            contractVersion, messageType, messageId, correlation, senderRole, senderSeq,
            sentAtUtc, sentAtUptimeMs, monotonicEpochId, systemId, deviceId, taskId, taskItemId,
            executionAttempt, runtimeSessionId, packageVersion, coreProtocolVersion, payload,
        )
    }
}
