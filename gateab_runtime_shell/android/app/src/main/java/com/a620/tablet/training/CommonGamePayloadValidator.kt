package com.a620.tablet.training

import a620.CanonicalJson

internal data class PreparedRuntimeFacts(
    val gameCode: String,
    val runtimeConfigHash: String,
    val plannedBatchCount: Long,
    val sessionStartLevel: Long,
    val durationMs: Long,
)

internal data class DurableBatchEvidence(
    val batchOrdinal: Long,
    val payloadSha256: String,
    val canonicalPayload: ByteArray,
)

internal data class CommonPayloadValidationSummary(
    val eligibleBatchCount: Long,
    val sessionRawScore: Long,
    val sessionEndLevel: Long,
    val nextStartLevel: Long,
    val derivedQualityFlag: String,
)

/**
 * Android-authoritative common game-payload validation.
 *
 * JSON Schema remains responsible for structural validation in the production
 * adapter. This validator closes the cross-field and cross-message rules that
 * JSON Schema alone cannot express: PREPARE mirroring, batch evidence equality,
 * level chaining, score totals, deadline audit, and highest-level semantics.
 */
internal object CommonGamePayloadValidator {
    fun validate(
        payload: Map<String, Any?>,
        prepared: PreparedRuntimeFacts,
        durableEvidence: List<DurableBatchEvidence>,
    ): CommonPayloadValidationSummary {
        require(payload.keys == setOf(
            "gameCode", "gamePayloadVersion", "runtimeConfigHash", "designMaxLevel",
            "plannedBatchCount", "eligibleBatchCount", "eligibleBatches", "incompleteBatchAudit",
            "sessionStartLevel", "sessionEndLevel", "sessionHighestPresentedLevel",
            "sessionHighestPassedLevel", "nextStartLevel", "sessionRawScore", "sessionRawScoreMax",
            "actualTrainingMs", "gameMetrics",
        )) { "common game payload fields mismatch" }
        require(payload.requiredString("gamePayloadVersion") == "A620-GP-1.1")
        require(payload.requiredString("gameCode") == prepared.gameCode) { "gameCode differs from PREPARE" }
        require(payload.requiredSha256("runtimeConfigHash") == prepared.runtimeConfigHash) {
            "runtimeConfigHash differs from PREPARE"
        }
        val planned = payload.requiredLong("plannedBatchCount", 1, 1024)
        require(planned == prepared.plannedBatchCount) { "plannedBatchCount differs from PREPARE" }
        val startLevel = payload.requiredLong("sessionStartLevel", 1, 10_000)
        require(startLevel == prepared.sessionStartLevel) { "sessionStartLevel differs from PREPARE" }
        val actualTrainingMs = payload.requiredLong("actualTrainingMs", 300_000, 300_000)
        require(actualTrainingMs == prepared.durationMs) { "actualTrainingMs differs from PREPARE" }
        val designMaxLevel = payload.requiredLong("designMaxLevel", 1, 10_000)
        require(startLevel <= designMaxLevel) { "sessionStartLevel exceeds designMaxLevel" }

        val eligible = payload.requiredObjectList("eligibleBatches", 1024)
        val incomplete = payload.requiredObjectList("incompleteBatchAudit", 1)
        val eligibleCount = payload.requiredLong("eligibleBatchCount", 0, planned)
        require(eligible.size.toLong() == eligibleCount) { "eligibleBatchCount mismatch" }
        require(eligible.size + incomplete.size <= planned.toInt()) { "batch evidence exceeds plannedBatchCount" }
        require(durableEvidence.size == eligible.size) { "durable BATCH_CLOSED count differs from final result" }

        var expectedLevel = startLevel
        var previousClosedAt = -1L
        var score = 0L
        var highestPresented = startLevel
        var highestPassed: Long? = null

        eligible.forEachIndexed { index, batch ->
            require(batch.keys == setOf(
                "batchOrdinal", "closed", "decisionEligible", "levelBefore", "resultZone",
                "levelTransition", "levelAfter", "batchScore", "closedAtActiveMs",
                "batchPayloadSha256", "gameBatchMetrics",
            )) { "eligible batch fields mismatch" }
            require(batch["gameBatchMetrics"] is Map<*, *>) { "gameBatchMetrics must be object" }
            val expectedOrdinal = (index + 1).toLong()
            val ordinal = batch.requiredLong("batchOrdinal", 1, planned)
            require(ordinal == expectedOrdinal) { "eligible batch ordinals must be contiguous from 1" }
            require(batch["closed"] == true && batch["decisionEligible"] == true) {
                "eligible batch must be closed and decision eligible"
            }
            val levelBefore = batch.requiredLong("levelBefore", 1, designMaxLevel)
            val levelAfter = batch.requiredLong("levelAfter", 1, designMaxLevel)
            require(levelBefore == expectedLevel) { "batch levelBefore does not chain from previous levelAfter" }
            validateTransition(batch, levelBefore, levelAfter, designMaxLevel)

            val closedAt = batch.requiredLong("closedAtActiveMs", 0, prepared.durationMs)
            require(closedAt > previousClosedAt) { "eligible batch close times must be strictly increasing" }
            previousClosedAt = closedAt

            val suppliedHash = batch.requiredSha256("batchPayloadSha256")
            val projection = LinkedHashMap(batch).apply { remove("batchPayloadSha256") }
            require(CanonicalJson.sha256(projection) == suppliedHash) { "final eligible batch hash is not self-consistent" }
            val durable = durableEvidence[index]
            require(durable.batchOrdinal == ordinal) { "durable batch ordinal mismatch" }
            require(durable.payloadSha256 == suppliedHash) { "final batch hash differs from BATCH_CLOSED evidence" }
            require(durable.canonicalPayload.contentEquals(CanonicalJson.canonicalBytes(batch))) {
                "final eligible batch content differs from durable BATCH_CLOSED payload"
            }

            val batchScore = batch.requiredLong("batchScore", 0, 100)
            score += batchScore
            highestPresented = maxOf(highestPresented, levelBefore)
            if (batch.requiredString("resultZone") == "UPGRADE") {
                highestPassed = maxNullable(highestPassed, levelBefore)
            }
            expectedLevel = levelAfter
        }

        if (incomplete.isNotEmpty()) {
            val audit = incomplete.single()
            require(audit.keys == setOf(
                "batchOrdinal", "levelBefore", "cutoffReason", "startedAtActiveMs", "cutoffAtActiveMs", "partialMetrics",
            )) { "incomplete batch fields mismatch" }
            require(audit.requiredLong("batchOrdinal", 1, planned) == eligibleCount + 1) {
                "incomplete batch must immediately follow eligible batches"
            }
            require(audit.requiredLong("levelBefore", 1, designMaxLevel) == expectedLevel) {
                "incomplete batch levelBefore does not match current level"
            }
            require(audit.requiredString("cutoffReason") == "DEADLINE") {
                "formal result incomplete batch reason must be DEADLINE"
            }
            val startedAt = audit.requiredLong("startedAtActiveMs", 0, prepared.durationMs)
            val cutoffAt = audit.requiredLong("cutoffAtActiveMs", prepared.durationMs, prepared.durationMs)
            require(startedAt >= previousClosedAt && startedAt <= cutoffAt) { "incomplete batch time order invalid" }
            require(audit["partialMetrics"] is Map<*, *>) { "partialMetrics must be object" }
            highestPresented = maxOf(highestPresented, expectedLevel)
        }

        require(payload.requiredLong("sessionRawScore", 0, planned * 100) == score) {
            "sessionRawScore does not equal eligible batch sum"
        }
        require(payload.requiredLong("sessionRawScoreMax", 100, 102_400) == planned * 100) {
            "sessionRawScoreMax must equal plannedBatchCount * 100"
        }
        val endLevel = payload.requiredLong("sessionEndLevel", 1, designMaxLevel)
        val nextStartLevel = payload.requiredLong("nextStartLevel", 1, designMaxLevel)
        require(endLevel == expectedLevel) { "sessionEndLevel does not match batch chain" }
        require(nextStartLevel == expectedLevel) { "nextStartLevel does not match batch chain" }
        require(payload.requiredLong("sessionHighestPresentedLevel", 1, designMaxLevel) == highestPresented) {
            "sessionHighestPresentedLevel does not match evidence"
        }
        val reportedPassed = payload.optionalLong("sessionHighestPassedLevel", 1, designMaxLevel)
        require(reportedPassed == highestPassed) { "sessionHighestPassedLevel does not match UPGRADE evidence" }
        require(payload["gameMetrics"] is Map<*, *>) { "gameMetrics must be object" }

        return CommonPayloadValidationSummary(
            eligibleBatchCount = eligibleCount,
            sessionRawScore = score,
            sessionEndLevel = endLevel,
            nextStartLevel = nextStartLevel,
            derivedQualityFlag = when {
                eligibleCount == planned -> "COMPLETE_BATCH_SET"
                eligibleCount == 0L -> "NO_ELIGIBLE_BATCH"
                else -> "PARTIAL_ELIGIBLE_BATCHES"
            },
        )
    }

    private fun validateTransition(batch: Map<String, Any?>, before: Long, after: Long, designMax: Long) {
        val zone = batch.requiredString("resultZone")
        val transition = batch.requiredString("levelTransition")
        when (zone) {
            "UPGRADE" -> when (transition) {
                "UP" -> require(before < designMax && after == before + 1) { "UP must advance exactly one level" }
                "HOLD_MAX" -> require(before == designMax && after == before) { "HOLD_MAX only legal at max level" }
                else -> error("UPGRADE must use UP or HOLD_MAX")
            }
            "HOLD" -> require(transition == "HOLD" && after == before) { "HOLD must keep same level" }
            "FAIL" -> when (transition) {
                "RETRY" -> require(after == before) { "RETRY must keep same level" }
                "DOWN" -> require(before > 1 && after == before - 1) { "DOWN must decrement exactly one level" }
                "HOLD_MIN" -> require(before == 1L && after == 1L) { "HOLD_MIN only legal at level 1" }
                else -> error("FAIL must use RETRY, DOWN or HOLD_MIN")
            }
            else -> error("unknown resultZone")
        }
    }

    private fun maxNullable(left: Long?, right: Long): Long = if (left == null) right else maxOf(left, right)

    private fun Map<String, Any?>.requiredString(name: String): String =
        (this[name] as? String)?.also { require(it.isNotBlank()) { "$name must not be blank" } }
            ?: error("$name must be string")

    private fun Map<String, Any?>.requiredSha256(name: String): String = requiredString(name).also {
        require(it.matches(Regex("^[0-9a-f]{64}$"))) { "$name must be lowercase SHA-256" }
    }

    private fun Map<String, Any?>.requiredLong(name: String, min: Long, max: Long): Long =
        (this[name] as? Long)?.also { require(it in min..max) { "$name out of range" } }
            ?: error("$name must be integer")

    private fun Map<String, Any?>.optionalLong(name: String, min: Long, max: Long): Long? = when (val value = this[name]) {
        null -> null
        is Long -> value.also { require(it in min..max) { "$name out of range" } }
        else -> error("$name must be integer or null")
    }

    private fun Map<String, Any?>.requiredObjectList(name: String, maxItems: Int): List<Map<String, Any?>> {
        val values = this[name] as? List<*> ?: error("$name must be array")
        require(values.size <= maxItems) { "$name too large" }
        return values.map { raw ->
            val objectValue = raw as? Map<*, *> ?: error("$name item must be object")
            LinkedHashMap<String, Any?>().also { out ->
                objectValue.forEach { (key, value) ->
                    require(key is String) { "$name key must be string" }
                    out[key] = value
                }
            }
        }
    }
}
