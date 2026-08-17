package com.a620.tablet.training

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.SystemClock
import a620.CanonicalJson
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import java.security.MessageDigest

class AndroidStoreConflict(message: String) : IllegalStateException(message)

enum class EventPersistenceDisposition { INSERTED, IDEMPOTENT_REPLAY, LATE_AUDIT }

data class FormalCommitReceipt(
    val resultId: String,
    val resultPayloadSha256: String,
    val derivedQualityFlag: String,
    val committedAtUtcMs: Long,
    val committedAtUptimeMs: Long,
    val ackMessageId: String,
    val idempotentReplay: Boolean,
)

/**
 * Application-private SQLite transaction core for the Android controller.
 *
 * This is intentionally a direct SQLiteOpenHelper implementation: the safety
 * boundary is one SQLite transaction, not a sequence of independent DAO calls.
 * A Room facade may be added later, but must preserve the same schema and the
 * result/sync/state/ACK/runtime-finalization transaction.
 */
class AndroidControllerStore(
    context: Context,
    databaseName: String = GeneratedRuntimeStoreSchema.DATABASE_NAME,
) : SQLiteOpenHelper(context, databaseName, null, GeneratedRuntimeStoreSchema.VERSION),
    ExecutionOutcomeWriter,
    ControllerOutboxStore {

    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        GeneratedRuntimeStoreSchema.STATEMENTS.forEach(db::execSQL)
        db.execSQL(
            "INSERT INTO controller_meta(singleton_id,schema_version,profile,profile_sha256,boot_epoch_id,last_uptime_ms,created_at_utc_ms,updated_at_utc_ms) VALUES(1,?,?,?,?,0,0,0)",
            arrayOf(
                GeneratedRuntimeStoreSchema.VERSION,
                GeneratedRuntimeStoreSchema.PROFILE,
                GeneratedRuntimeStoreSchema.PROFILE_SHA256,
                null,
            ),
        )
    }

    override fun onOpen(db: SQLiteDatabase) {
        super.onOpen(db)
        verifyDatabase(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw AndroidStoreConflict(
            "no deployed migration is approved for $oldVersion->$newVersion; fail closed",
        )
    }

    override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw AndroidStoreConflict("database downgrade is forbidden: $oldVersion->$newVersion")
    }

    /**
     * Binds uptime to one boot epoch. Active sessions are interrupted if the
     * device rebooted or if uptime regressed inside the same claimed epoch.
     */
    fun bindBootEpoch(bootEpochId: String, nowUtcMs: Long, nowUptimeMs: Long): List<String> {
        requireId(bootEpochId, "bootEpochId")
        require(nowUtcMs >= 0 && nowUptimeMs >= 0)
        return writableDatabase.inTransaction {
            val row = rawQuery(
                "SELECT boot_epoch_id,last_uptime_ms FROM controller_meta WHERE singleton_id=1",
                emptyArray(),
            ).use { cursor ->
                if (!cursor.moveToFirst()) throw AndroidStoreConflict("controller_meta missing")
                Pair(if (cursor.isNull(0)) null else cursor.getString(0), cursor.getLong(1))
            }
            val reason = when {
                row.first == null -> null
                row.first != bootEpochId -> "INTERRUPTED_DEVICE_REBOOT"
                nowUptimeMs < row.second -> "INTERRUPTED_UPTIME_REGRESSION"
                else -> null
            }
            val interrupted = if (reason == null) emptyList() else activeRuntimeIds().also { ids ->
                ids.forEach { interruptRuntimeTx(it, "INTERRUPTED", reason, nowUtcMs, nowUptimeMs) }
            }
            execSQL(
                "UPDATE controller_meta SET boot_epoch_id=?,last_uptime_ms=?,updated_at_utc_ms=? WHERE singleton_id=1",
                arrayOf(bootEpochId, nowUptimeMs, nowUtcMs),
            )
            interrupted
        }
    }

    fun registerPreparedRuntime(
        prepare: RuntimeWireEnvelope,
        canonicalJson: ByteArray,
        nowUtcMs: Long,
        nowUptimeMs: Long,
    ): Boolean {
        require(prepare.messageType == "PREPARE")
        require(prepare.senderRole == "ANDROID_CONTROLLER")
        require(nowUtcMs >= 0 && nowUptimeMs >= 0)
        requireCanonicalEnvelope(prepare, canonicalJson)
        val gameCode = prepare.payload.requiredString("gameCode")
        val configHash = prepare.payload.requiredSha256("runtimeConfigHash")
        val plannedBatchCount = prepare.payload.requiredLong("plannedBatchCount", 1, 1024)
        val startLevel = prepare.payload.requiredLong("sessionStartLevel", 1, 10_000)
        val durationMs = prepare.payload.requiredLong("durationMs", 300_000, 300_000)

        return writableDatabase.inTransaction {
            requireBoundBootEpochTx(prepare.monotonicEpochId, nowUptimeMs)
            rawQuery(
                "SELECT task_item_id,execution_attempt,prepare_canonical_json FROM runtime_session WHERE runtime_session_id=?",
                arrayOf(prepare.runtimeSessionId),
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    if (cursor.getString(0) != prepare.taskItemId ||
                        cursor.getLong(1) != prepare.executionAttempt ||
                        !cursor.getBlob(2).contentEquals(canonicalJson)
                    ) {
                        throw AndroidStoreConflict("runtimeSessionId replay differs from original PREPARE")
                    }
                    return@inTransaction false
                }
            }

            rawQuery(
                "SELECT runtime_session_id,task_item_id,execution_attempt FROM runtime_session WHERE lifecycle='ACTIVE' LIMIT 1",
                emptyArray(),
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    val oldRuntimeId = cursor.getString(0)
                    val oldTaskItemId = cursor.getString(1)
                    val oldAttempt = cursor.getLong(2)
                    if (oldTaskItemId != prepare.taskItemId) {
                        throw AndroidStoreConflict("another task item owns the single training runtime slot")
                    }
                    when {
                        oldAttempt > prepare.executionAttempt -> throw AndroidStoreConflict("stale executionAttempt")
                        oldAttempt == prepare.executionAttempt -> throw AndroidStoreConflict(
                            "same task item/attempt already has another active runtime",
                        )
                        else -> interruptRuntimeTx(
                            oldRuntimeId,
                            "INTERRUPTED",
                            "EXECUTION_SUPERSEDED_BY_NEW_ATTEMPT",
                            nowUtcMs,
                            nowUptimeMs,
                        )
                    }
                }
            }

            val values = ContentValues().apply {
                put("runtime_session_id", prepare.runtimeSessionId)
                put("system_id", prepare.systemId)
                put("device_id", prepare.deviceId)
                put("task_id", prepare.taskId)
                put("task_item_id", prepare.taskItemId)
                put("execution_attempt", prepare.executionAttempt)
                put("monotonic_epoch_id", prepare.monotonicEpochId)
                put("package_version", prepare.packageVersion)
                put("core_protocol_version", prepare.coreProtocolVersion)
                put("game_code", gameCode)
                put("runtime_config_hash", configHash)
                put("planned_batch_count", plannedBatchCount)
                put("session_start_level", startLevel)
                put("duration_ms", durationMs)
                put("lifecycle", "ACTIVE")
                putNull("finalization_kind")
                putNull("terminal_reason")
                put("prepare_message_id", prepare.messageId)
                put("prepare_canonical_json", canonicalJson)
                put("created_at_utc_ms", nowUtcMs)
                put("created_at_uptime_ms", nowUptimeMs)
                put("updated_at_utc_ms", nowUtcMs)
                put("updated_at_uptime_ms", nowUptimeMs)
            }
            if (insertWithOnConflict("runtime_session", null, values, SQLiteDatabase.CONFLICT_IGNORE) == -1L) {
                throw AndroidStoreConflict("runtime identity conflicts with existing task/attempt")
            }
            insertEventTx(prepare, canonicalJson, nowUptimeMs)
            true
        }
    }

    fun persistRuntimeEvent(
        envelope: RuntimeWireEnvelope,
        canonicalJson: ByteArray,
        receivedAtUptimeMs: Long,
    ): EventPersistenceDisposition {
        require(receivedAtUptimeMs >= 0)
        requireCanonicalEnvelope(envelope, canonicalJson)
        return writableDatabase.inTransaction {
            requireBoundBootEpochTx(envelope.monotonicEpochId, receivedAtUptimeMs)
            val lifecycle = runtimeLifecycle(envelope.runtimeSessionId)
            if (lifecycle == null) throw AndroidStoreConflict("unknown runtimeSessionId")
            if (lifecycle != "ACTIVE") {
                insertLateAuditTx(envelope, canonicalJson, "TERMINAL_RUNTIME_CALLBACK", receivedAtUptimeMs)
                return@inTransaction EventPersistenceDisposition.LATE_AUDIT
            }
            requireActiveRuntimeTx(envelope)
            val disposition = insertEventTx(envelope, canonicalJson, receivedAtUptimeMs)
            if (envelope.messageType == "BATCH_CLOSED") {
                insertBatchEvidenceTx(
                    envelope = envelope,
                    receivedAtUptimeMs = receivedAtUptimeMs,
                    allowInsert = disposition == EventPersistenceDisposition.INSERTED,
                )
            }
            disposition
        }
    }

    data class StoredCommittedAck(
        val receipt: FormalCommitReceipt,
        val envelope: RuntimeWireEnvelope,
        val canonicalJson: ByteArray,
    )

    fun loadCommittedAck(
        resultReady: RuntimeWireEnvelope,
        canonicalResultReady: ByteArray,
    ): StoredCommittedAck? {
        requireCanonicalEnvelope(resultReady, canonicalResultReady)
        return readableDatabase.rawQuery(
            "SELECT f.result_id,f.result_payload_sha256,f.derived_quality_flag,f.committed_at_utc_ms,f.committed_at_uptime_ms," +
                "f.ack_message_id,o.canonical_json,o.canonical_sha256,i.canonical_json " +
                "FROM formal_training_result f " +
                "JOIN controller_outbox o ON o.message_id=f.ack_message_id " +
                "JOIN controller_event_inbox i ON i.message_id=f.result_ready_message_id " +
                "WHERE f.runtime_session_id=? AND f.result_ready_message_id=?",
            arrayOf(resultReady.runtimeSessionId, resultReady.messageId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            FormalResultReplayValidator.requireExactReplay(
                incoming = resultReady,
                incomingCanonical = canonicalResultReady,
                persistedResultReadyMessageId = resultReady.messageId,
                persistedResultReadyCanonical = cursor.getBlob(8),
                persistedResultPayloadSha256 = cursor.getString(1),
            )
            val bytes = cursor.getBlob(6)
            if (sha256Hex(bytes) != cursor.getString(7)) {
                throw AndroidStoreConflict("durable ACK canonical hash mismatch")
            }
            val envelope = RuntimeWireEnvelopeParser.parseCanonical(
                canonicalBytes = bytes,
                expectedSenderRole = "ANDROID_CONTROLLER",
            )
            requireSameExecutionIdentity(resultReady, envelope)
            if (envelope.correlationId != resultReady.messageId) {
                throw AndroidStoreConflict("durable ACK no longer correlates to RESULT_READY")
            }
            val committedAtUtc = java.time.Instant.ofEpochMilli(cursor.getLong(3)).toString()
            if (envelope.messageId != cursor.getString(5) ||
                envelope.payload.requiredString("resultId") != cursor.getString(0) ||
                envelope.payload.requiredSha256("resultPayloadSha256") != cursor.getString(1) ||
                envelope.payload.requiredString("committedAtUtc") != committedAtUtc ||
                envelope.payload.requiredLong("committedAtUptimeMs", 0, CanonicalJson.SAFE_INTEGER_MAX) != cursor.getLong(4)
            ) {
                throw AndroidStoreConflict("durable ACK facts differ from committed result row")
            }
            StoredCommittedAck(
                FormalCommitReceipt(
                    resultId = cursor.getString(0),
                    resultPayloadSha256 = cursor.getString(1),
                    derivedQualityFlag = cursor.getString(2),
                    committedAtUtcMs = cursor.getLong(3),
                    committedAtUptimeMs = cursor.getLong(4),
                    ackMessageId = cursor.getString(5),
                    idempotentReplay = true,
                ),
                envelope,
                bytes,
            )
        }
    }

    /**
     * RESULT_READY is retried with the same message identity until Cocos sees
     * ACK_RESULT_COMMITTED. A previous oneway Binder return is not remote
     * application acknowledgement, so an exact replay reopens the same durable
     * ACK bytes without changing result facts or sender sequence.
     */
    fun requeueCommittedAckForExactResultReplay(
        resultReady: RuntimeWireEnvelope,
        canonicalResultReady: ByteArray,
        nowUtcMs: Long,
    ): StoredCommittedAck? {
        require(nowUtcMs in 0..CanonicalJson.SAFE_INTEGER_MAX)
        val stored = loadCommittedAck(resultReady, canonicalResultReady) ?: return null
        writableDatabase.inTransaction {
            val status = rawQuery(
                "SELECT status,next_attempt_at_utc_ms FROM controller_outbox WHERE message_id=? AND message_type='ACK_RESULT_COMMITTED'",
                arrayOf(stored.receipt.ackMessageId),
            ).use { cursor ->
                if (!cursor.moveToFirst()) throw AndroidStoreConflict("committed ACK outbox row missing")
                Pair(cursor.getString(0), cursor.getLong(1))
            }
            when (status.first) {
                "ACKED" -> {
                    execSQL(
                        "UPDATE controller_outbox SET status='PENDING',next_attempt_at_utc_ms=?,claim_owner=NULL,claim_until_utc_ms=NULL,last_error=NULL WHERE message_id=? AND status='ACKED'",
                        arrayOf(nowUtcMs, stored.receipt.ackMessageId),
                    )
                    if (changes() != 1L) throw AndroidStoreConflict("committed ACK replay requeue lost race")
                }
                "PENDING" -> if (status.second > nowUtcMs) {
                    execSQL(
                        "UPDATE controller_outbox SET next_attempt_at_utc_ms=?,last_error=NULL WHERE message_id=? AND status='PENDING'",
                        arrayOf(nowUtcMs, stored.receipt.ackMessageId),
                    )
                    if (changes() != 1L) throw AndroidStoreConflict("committed ACK replay acceleration lost race")
                }
                "IN_FLIGHT" -> Unit // Existing fenced sender will complete or its lease will expire.
                "CANCELLED" -> throw AndroidStoreConflict("committed ACK was cancelled and cannot be silently resurrected")
                else -> throw AndroidStoreConflict("unknown committed ACK outbox status")
            }
        }
        return stored
    }

    fun reserveNextControllerSenderSeq(runtimeSessionId: String): Long = writableDatabase.inTransaction {
        if (runtimeLifecycle(runtimeSessionId) != "ACTIVE") {
            throw AndroidStoreConflict("cannot reserve sender sequence for terminal or unknown runtime")
        }
        val last = rawQuery(
            "SELECT last_seq FROM sender_sequence_ledger WHERE runtime_session_id=? AND sender_role='ANDROID_CONTROLLER'",
            arrayOf(runtimeSessionId),
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L }
        val next = last + 1L
        require(next <= CanonicalJson.SAFE_INTEGER_MAX) { "controller sender sequence exhausted" }
        upsertSenderCursorTx(
            runtimeSessionId,
            "ANDROID_CONTROLLER",
            next,
            lastSentAtUptimeMs = null,
            cursorExists = last > 0L,
        )
        next
    }

    fun commitFormalResult(
        resultReady: RuntimeWireEnvelope,
        canonicalResultReady: ByteArray,
        resultId: String,
        ackEnvelope: RuntimeWireEnvelope,
        canonicalAck: ByteArray,
        committedAtUtcMs: Long,
        committedAtUptimeMs: Long,
    ): FormalCommitReceipt {
        require(resultReady.messageType == "RESULT_READY" && resultReady.senderRole == "COCOS_RUNTIME")
        require(ackEnvelope.messageType == "ACK_RESULT_COMMITTED" && ackEnvelope.senderRole == "ANDROID_CONTROLLER")
        requireId(resultId, "resultId")
        require(committedAtUtcMs >= 0 && committedAtUptimeMs >= 0)
        requireCanonicalEnvelope(resultReady, canonicalResultReady)
        requireCanonicalEnvelope(ackEnvelope, canonicalAck)
        requireSameExecutionIdentity(resultReady, ackEnvelope)
        require(ackEnvelope.correlationId == resultReady.messageId)
        val committedAtUtc = java.time.Instant.ofEpochMilli(committedAtUtcMs).toString()
        require(resultReady.sentAtUptimeMs <= committedAtUptimeMs) { "RESULT_READY cannot be committed before it was sent" }
        require(ackEnvelope.sentAtUptimeMs == committedAtUptimeMs) { "ACK sentAtUptimeMs must equal commit boundary" }
        require(ackEnvelope.sentAtUtc == committedAtUtc) { "ACK sentAtUtc must equal commit time" }

        val gamePayload = resultReady.payload["gamePayload"] as? Map<*, *>
            ?: throw AndroidStoreConflict("RESULT_READY.gamePayload missing")
        val normalizedGamePayload = gamePayload.stringKeyMap()
        val resultHash = resultReady.payload.requiredSha256("resultDraftSha256")
        if (CanonicalJson.sha256(normalizedGamePayload) != resultHash) {
            throw AndroidStoreConflict("RESULT_READY resultDraftSha256 mismatch")
        }
        if (ackEnvelope.payload.requiredString("resultId") != resultId ||
            ackEnvelope.payload.requiredSha256("resultPayloadSha256") != resultHash ||
            ackEnvelope.payload.requiredString("committedAtUtc") != committedAtUtc ||
            ackEnvelope.payload.requiredLong("committedAtUptimeMs", 0, CanonicalJson.SAFE_INTEGER_MAX) != committedAtUptimeMs
        ) {
            throw AndroidStoreConflict("ACK_RESULT_COMMITTED does not echo committed result facts")
        }

        return writableDatabase.inTransaction {
            requireBoundBootEpochTx(resultReady.monotonicEpochId, committedAtUptimeMs)
            rawQuery(
                "SELECT f.result_id,f.result_payload_sha256,f.derived_quality_flag,f.committed_at_utc_ms," +
                    "f.committed_at_uptime_ms,f.ack_message_id,f.result_ready_message_id,i.canonical_json " +
                    "FROM formal_training_result f JOIN controller_event_inbox i ON i.message_id=f.result_ready_message_id " +
                    "WHERE f.runtime_session_id=?",
                arrayOf(resultReady.runtimeSessionId),
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    FormalResultReplayValidator.requireExactReplay(
                        incoming = resultReady,
                        incomingCanonical = canonicalResultReady,
                        persistedResultReadyMessageId = cursor.getString(6),
                        persistedResultReadyCanonical = cursor.getBlob(7),
                        persistedResultPayloadSha256 = cursor.getString(1),
                    )
                    if (cursor.getString(0) != resultId ||
                        cursor.getString(5) != ackEnvelope.messageId
                    ) {
                        throw AndroidStoreConflict("formal result replay differs from first commit")
                    }
                    return@inTransaction FormalCommitReceipt(
                        resultId = cursor.getString(0),
                        resultPayloadSha256 = cursor.getString(1),
                        derivedQualityFlag = cursor.getString(2),
                        committedAtUtcMs = cursor.getLong(3),
                        committedAtUptimeMs = cursor.getLong(4),
                        ackMessageId = cursor.getString(5),
                        idempotentReplay = true,
                    )
                }
            }

            requireActiveRuntimeTx(resultReady)
            insertEventTx(resultReady, canonicalResultReady, committedAtUptimeMs)
            val validation = reconcileBatchesTx(resultReady.runtimeSessionId, normalizedGamePayload)

            execSQL(
                "INSERT INTO formal_training_result(result_id,runtime_session_id,result_ready_message_id,result_payload_sha256,derived_quality_flag,canonical_result,committed_at_utc_ms,committed_at_uptime_ms,ack_message_id) VALUES(?,?,?,?,?,?,?,?,?)",
                arrayOf(
                    resultId,
                    resultReady.runtimeSessionId,
                    resultReady.messageId,
                    resultHash,
                    validation.derivedQualityFlag,
                    CanonicalJson.canonicalBytes(normalizedGamePayload),
                    committedAtUtcMs,
                    committedAtUptimeMs,
                    ackEnvelope.messageId,
                ),
            )
            execSQL(
                "INSERT INTO result_sync_queue(result_id,sync_state,attempt_count,next_attempt_at_utc_ms,last_error) VALUES(?,'PENDING_UPLOAD',0,?,NULL)",
                arrayOf(resultId, committedAtUtcMs),
            )
            execSQL(
                "INSERT INTO controller_state(runtime_session_id,completion_state,sync_state,task_slot_state,result_id,updated_at_utc_ms,updated_at_uptime_ms) VALUES(?,'COMPLETE','PENDING_UPLOAD','OCCUPIED',?,?,?)",
                arrayOf(resultReady.runtimeSessionId, resultId, committedAtUtcMs, committedAtUptimeMs),
            )
            insertOutboxTx(ackEnvelope, canonicalAck, committedAtUtcMs, priority = "CRITICAL")
            execSQL(
                "UPDATE runtime_session SET lifecycle='TERMINAL',finalization_kind='RESULT',terminal_reason=NULL,updated_at_utc_ms=?,updated_at_uptime_ms=? WHERE runtime_session_id=? AND lifecycle='ACTIVE' AND finalization_kind IS NULL",
                arrayOf(committedAtUtcMs, committedAtUptimeMs, resultReady.runtimeSessionId),
            )
            if (changes() != 1L) throw AndroidStoreConflict("runtime finalization lost race")

            FormalCommitReceipt(
                resultId,
                resultHash,
                validation.derivedQualityFlag,
                committedAtUtcMs,
                committedAtUptimeMs,
                ackEnvelope.messageId,
                false,
            )
        }
    }

    override fun claimDueControllerOutbox(
        runtimeSessionId: String,
        ownerId: String,
        nowUtcMs: Long,
        leaseMs: Long,
        limit: Int,
    ): List<ClaimedControllerMessage> {
        requireId(runtimeSessionId, "runtimeSessionId")
        requireId(ownerId, "ownerId")
        require(nowUtcMs in 0..CanonicalJson.SAFE_INTEGER_MAX)
        require(leaseMs in 1..300_000)
        require(limit in 1..64)
        val claimUntil = Math.addExact(nowUtcMs, leaseMs)
        require(claimUntil <= CanonicalJson.SAFE_INTEGER_MAX)
        return writableDatabase.inTransaction {
            data class Candidate(
                val messageId: String,
                val runtimeSessionId: String,
                val messageType: String,
                val senderSeq: Long,
                val canonicalSha256: String,
                val canonicalJson: ByteArray,
                val attemptCount: Int,
                val oldClaimGeneration: Long,
                val status: String,
                val nextAttemptAtUtcMs: Long,
                val claimUntilUtcMs: Long?,
            )
            // Sender sequence is authoritative. Only the smallest unresolved
            // row may be claimed; priority affects admission capacity, never
            // execution order. This prevents a later critical message from
            // creating a senderSeq gap at the remote reducer.
            val candidate = rawQuery(
                "SELECT message_id,runtime_session_id,message_type,sender_seq,canonical_sha256,canonical_json," +
                    "attempt_count,claim_generation,status,next_attempt_at_utc_ms,claim_until_utc_ms " +
                    "FROM controller_outbox WHERE runtime_session_id=? AND status IN ('PENDING','IN_FLIGHT') " +
                    "ORDER BY sender_seq,created_at_utc_ms,message_id LIMIT 1",
                arrayOf(runtimeSessionId),
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else Candidate(
                    cursor.getString(0),
                    cursor.getString(1),
                    cursor.getString(2),
                    cursor.getLong(3),
                    cursor.getString(4),
                    cursor.getBlob(5),
                    cursor.getLong(6).toInt(),
                    cursor.getLong(7),
                    cursor.getString(8),
                    cursor.getLong(9),
                    if (cursor.isNull(10)) null else cursor.getLong(10),
                )
            } ?: return@inTransaction emptyList()

            val dueAt = when (candidate.status) {
                "PENDING" -> candidate.nextAttemptAtUtcMs
                "IN_FLIGHT" -> maxOf(
                    candidate.nextAttemptAtUtcMs,
                    candidate.claimUntilUtcMs
                        ?: throw AndroidStoreConflict("IN_FLIGHT outbox row has no claim deadline"),
                )
                else -> throw AndroidStoreConflict("unexpected unresolved outbox status")
            }
            if (dueAt > nowUtcMs) return@inTransaction emptyList()

            val generation = candidate.oldClaimGeneration + 1L
            require(generation <= CanonicalJson.SAFE_INTEGER_MAX) { "outbox claim generation exhausted" }
            execSQL(
                "UPDATE controller_outbox SET status='IN_FLIGHT',claim_owner=?,claim_generation=?,claim_until_utc_ms=?,last_error=NULL " +
                    "WHERE message_id=? AND runtime_session_id=? AND status=? AND claim_generation=?",
                arrayOf(
                    ownerId,
                    generation,
                    claimUntil,
                    candidate.messageId,
                    runtimeSessionId,
                    candidate.status,
                    candidate.oldClaimGeneration,
                ),
            )
            if (changes() != 1L) throw AndroidStoreConflict("outbox claim lost race")
            listOf(
                ClaimedControllerMessage(
                    candidate.messageId,
                    candidate.runtimeSessionId,
                    candidate.messageType,
                    candidate.senderSeq,
                    candidate.canonicalSha256,
                    candidate.canonicalJson,
                    candidate.attemptCount,
                    generation,
                ),
            )
        }
    }

    override fun nextControllerOutboxDueAtUtcMs(runtimeSessionId: String): Long? {
        requireId(runtimeSessionId, "runtimeSessionId")
        return readableDatabase.rawQuery(
            "SELECT status,next_attempt_at_utc_ms,claim_until_utc_ms FROM controller_outbox " +
                "WHERE runtime_session_id=? AND status IN ('PENDING','IN_FLIGHT') " +
                "ORDER BY sender_seq,created_at_utc_ms,message_id LIMIT 1",
            arrayOf(runtimeSessionId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            when (cursor.getString(0)) {
                "PENDING" -> cursor.getLong(1)
                "IN_FLIGHT" -> maxOf(
                    cursor.getLong(1),
                    if (cursor.isNull(2)) throw AndroidStoreConflict("IN_FLIGHT outbox row has no claim deadline")
                    else cursor.getLong(2),
                )
                else -> throw AndroidStoreConflict("unexpected unresolved outbox status")
            }
        }
    }

    override fun markControllerOutboxSubmitted(
        messageId: String,
        ownerId: String,
        claimGeneration: Long,
    ) {
        requireId(messageId, "messageId")
        requireId(ownerId, "ownerId")
        writableDatabase.inTransaction {
            execSQL(
                "UPDATE controller_outbox SET status='ACKED',attempt_count=attempt_count+1,claim_owner=NULL,claim_until_utc_ms=NULL,last_error=NULL " +
                    "WHERE message_id=? AND status='IN_FLIGHT' AND claim_owner=? AND claim_generation=?",
                arrayOf(messageId, ownerId, claimGeneration),
            )
            if (changes() != 1L) throw AndroidStoreConflict("outbox submit fence mismatch")
        }
    }

    override fun markControllerOutboxRetry(
        messageId: String,
        ownerId: String,
        claimGeneration: Long,
        nextAttemptAtUtcMs: Long,
        error: String,
    ) {
        requireId(messageId, "messageId")
        requireId(ownerId, "ownerId")
        require(nextAttemptAtUtcMs in 0..CanonicalJson.SAFE_INTEGER_MAX)
        require(error.isNotBlank())
        writableDatabase.inTransaction {
            execSQL(
                "UPDATE controller_outbox SET status='PENDING',attempt_count=attempt_count+1,next_attempt_at_utc_ms=?,claim_owner=NULL,claim_until_utc_ms=NULL,last_error=? " +
                    "WHERE message_id=? AND status='IN_FLIGHT' AND claim_owner=? AND claim_generation=?",
                arrayOf(nextAttemptAtUtcMs, error.take(256), messageId, ownerId, claimGeneration),
            )
            if (changes() != 1L) throw AndroidStoreConflict("outbox retry fence mismatch")
        }
    }

    override fun markControllerOutboxPoisoned(
        messageId: String,
        ownerId: String,
        claimGeneration: Long,
        error: String,
    ) {
        requireId(messageId, "messageId")
        requireId(ownerId, "ownerId")
        require(error.isNotBlank())
        writableDatabase.inTransaction {
            execSQL(
                "UPDATE controller_outbox SET status='CANCELLED',attempt_count=attempt_count+1,claim_owner=NULL,claim_until_utc_ms=NULL,last_error=? " +
                    "WHERE message_id=? AND status='IN_FLIGHT' AND claim_owner=? AND claim_generation=?",
                arrayOf(error.take(256), messageId, ownerId, claimGeneration),
            )
            if (changes() != 1L) throw AndroidStoreConflict("outbox poison fence mismatch")
        }
    }

    override fun recordInterrupted(
        runtimeSessionId: String,
        executionAttempt: Long,
        reason: String,
        observedAtUptimeMs: Long,
    ) {
        try {
            recordExecutionOutcome(
                runtimeSessionId,
                executionAttempt,
                "INTERRUPTED",
                reason,
                System.currentTimeMillis(),
                observedAtUptimeMs,
            )
        } catch (conflict: AndroidStoreConflict) {
            // Once the formal result transaction committed, a later training
            // process death is transport/audit information only. It must never
            // rewrite COMPLETE into INTERRUPTED or cancel the durable ACK.
            if (!hasFormalResult(runtimeSessionId)) throw conflict
            recordTransportAudit(
                runtimeSessionId,
                null,
                "INFRASTRUCTURE_FAILURE",
                "POST_COMMIT_RUNTIME_FAILURE:${reason.take(200)}",
                observedAtUptimeMs,
            )
        }
    }

    fun recordExecutionOutcome(
        runtimeSessionId: String,
        executionAttempt: Long,
        completionState: String,
        reason: String,
        observedAtUtcMs: Long,
        observedAtUptimeMs: Long,
    ): Boolean {
        require(completionState in setOf("INTERRUPTED", "DISCARDED"))
        require(reason.isNotBlank() && reason.length <= 256)
        return writableDatabase.inTransaction {
            val row = rawQuery(
                "SELECT execution_attempt,lifecycle,finalization_kind FROM runtime_session WHERE runtime_session_id=?",
                arrayOf(runtimeSessionId),
            ).use { cursor ->
                if (!cursor.moveToFirst()) throw AndroidStoreConflict("unknown runtime")
                Triple(cursor.getLong(0), cursor.getString(1), if (cursor.isNull(2)) null else cursor.getString(2))
            }
            if (row.first != executionAttempt) throw AndroidStoreConflict("executionAttempt mismatch")
            if (row.second == "TERMINAL") {
                if (row.third != "OUTCOME") throw AndroidStoreConflict("runtime already finalized with result")
                rawQuery(
                    "SELECT completion_state,reason FROM execution_outcome WHERE runtime_session_id=?",
                    arrayOf(runtimeSessionId),
                ).use { cursor ->
                    if (!cursor.moveToFirst()) throw AndroidStoreConflict("terminal outcome row missing")
                    if (cursor.getString(0) != completionState || cursor.getString(1) != reason) {
                        throw AndroidStoreConflict("execution outcome replay differs from first terminal facts")
                    }
                }
                return@inTransaction false
            }
            interruptRuntimeTx(
                runtimeSessionId,
                completionState,
                reason,
                observedAtUtcMs,
                observedAtUptimeMs,
            )
            true
        }
    }

    fun recordTransportAudit(
        runtimeSessionId: String,
        messageId: String?,
        eventKind: String,
        reason: String,
        observedAtUptimeMs: Long,
    ) {
        require(eventKind in setOf("STALE_CHANNEL", "TELEMETRY_DROPPED", "INFRASTRUCTURE_FAILURE", "OUTBOX_CORRUPT"))
        require(reason.isNotBlank())
        writableDatabase.execSQL(
            "INSERT INTO runtime_transport_audit(runtime_session_id,message_id,event_kind,reason,observed_at_utc_ms,observed_at_uptime_ms) VALUES(?,?,?,?,?,?)",
            arrayOf(
                runtimeSessionId,
                messageId,
                eventKind,
                reason.take(256),
                System.currentTimeMillis(),
                observedAtUptimeMs,
            ),
        )
    }

    fun verifyDurabilityInvariants() = verifyDatabase(readableDatabase)

    private fun SQLiteDatabase.insertEventTx(
        envelope: RuntimeWireEnvelope,
        canonicalJson: ByteArray,
        receivedAtUptimeMs: Long,
    ): EventPersistenceDisposition {
        val sha = sha256Hex(canonicalJson)
        rawQuery(
            "SELECT runtime_session_id,sender_seq,canonical_sha256 FROM controller_outbox WHERE message_id=?",
            arrayOf(envelope.messageId),
        ).use { cursor ->
            if (cursor.moveToFirst()) throw AndroidStoreConflict("messageId already belongs to controller outbox")
        }
        if (envelope.senderRole == "ANDROID_CONTROLLER") {
            rawQuery(
                "SELECT message_id FROM controller_outbox WHERE runtime_session_id=? AND sender_seq=?",
                arrayOf(envelope.runtimeSessionId, envelope.senderSeq.toString()),
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    throw AndroidStoreConflict("ANDROID_CONTROLLER senderSeq already belongs to outbox")
                }
            }
        }
        rawQuery(
            "SELECT runtime_session_id,message_type,sender_role,sender_seq,canonical_sha256,canonical_json FROM controller_event_inbox WHERE message_id=?",
            arrayOf(envelope.messageId),
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                if (cursor.getString(0) != envelope.runtimeSessionId ||
                    cursor.getString(1) != envelope.messageType ||
                    cursor.getString(2) != envelope.senderRole ||
                    cursor.getLong(3) != envelope.senderSeq ||
                    cursor.getString(4) != sha ||
                    !cursor.getBlob(5).contentEquals(canonicalJson)
                ) {
                    throw AndroidStoreConflict("messageId replay differs from original canonical event")
                }
                return EventPersistenceDisposition.IDEMPOTENT_REPLAY
            }
        }
        rawQuery(
            "SELECT message_id,canonical_sha256 FROM controller_event_inbox WHERE runtime_session_id=? AND sender_role=? AND sender_seq=?",
            arrayOf(envelope.runtimeSessionId, envelope.senderRole, envelope.senderSeq.toString()),
        ).use { cursor ->
            if (cursor.moveToFirst()) throw AndroidStoreConflict("senderSeq reused by another message")
        }
        val senderCursor = rawQuery(
            "SELECT last_seq,last_sent_at_uptime_ms FROM sender_sequence_ledger WHERE runtime_session_id=? AND sender_role=?",
            arrayOf(envelope.runtimeSessionId, envelope.senderRole),
        ).use { cursor ->
            if (cursor.moveToFirst()) Triple(cursor.getLong(0), cursor.getLong(1), true)
            else Triple(0L, 0L, false)
        }
        if (envelope.senderSeq <= senderCursor.first) {
            throw AndroidStoreConflict("new message senderSeq is not strictly increasing")
        }
        if (envelope.sentAtUptimeMs < senderCursor.second) {
            throw AndroidStoreConflict("sender uptime regressed")
        }
        if (receivedAtUptimeMs < envelope.sentAtUptimeMs) {
            throw AndroidStoreConflict("message received before sender uptime")
        }
        upsertSenderCursorTx(
            envelope.runtimeSessionId,
            envelope.senderRole,
            envelope.senderSeq,
            envelope.sentAtUptimeMs,
            cursorExists = senderCursor.third,
        )

        val values = ContentValues().apply {
            put("message_id", envelope.messageId)
            put("runtime_session_id", envelope.runtimeSessionId)
            put("message_type", envelope.messageType)
            put("sender_role", envelope.senderRole)
            put("sender_seq", envelope.senderSeq)
            put("canonical_sha256", sha)
            put("canonical_json", canonicalJson)
            put("sent_at_uptime_ms", envelope.sentAtUptimeMs)
            put("received_at_uptime_ms", receivedAtUptimeMs)
        }
        if (insertWithOnConflict("controller_event_inbox", null, values, SQLiteDatabase.CONFLICT_IGNORE) == -1L) {
            throw AndroidStoreConflict("event identity conflict")
        }
        return EventPersistenceDisposition.INSERTED
    }

    private fun SQLiteDatabase.insertLateAuditTx(
        envelope: RuntimeWireEnvelope,
        canonicalJson: ByteArray,
        reason: String,
        receivedAtUptimeMs: Long,
    ) {
        val hash = sha256Hex(canonicalJson)
        rawQuery(
            "SELECT runtime_session_id,message_type,sender_role,sender_seq,canonical_sha256 " +
                "FROM late_event_audit WHERE message_id=? AND reason=?",
            arrayOf(envelope.messageId, reason),
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                if (cursor.getString(0) != envelope.runtimeSessionId ||
                    cursor.getString(1) != envelope.messageType ||
                    cursor.getString(2) != envelope.senderRole ||
                    cursor.getLong(3) != envelope.senderSeq ||
                    cursor.getString(4) != hash
                ) {
                    throw AndroidStoreConflict("late message replay differs from first audited event")
                }
                return
            }
        }
        execSQL(
            "INSERT INTO late_event_audit(runtime_session_id,message_id,message_type,sender_role,sender_seq,canonical_sha256,reason,received_at_uptime_ms) VALUES(?,?,?,?,?,?,?,?)",
            arrayOf(
                envelope.runtimeSessionId,
                envelope.messageId,
                envelope.messageType,
                envelope.senderRole,
                envelope.senderSeq,
                hash,
                reason,
                receivedAtUptimeMs,
            ),
        )
    }

    private fun SQLiteDatabase.insertBatchEvidenceTx(
        envelope: RuntimeWireEnvelope,
        receivedAtUptimeMs: Long,
        allowInsert: Boolean,
    ) {
        val p = envelope.payload
        require(p["closed"] == true && p["decisionEligible"] == true) {
            "BATCH_CLOSED evidence must be closed and decision eligible"
        }
        val ordinal = p.requiredLong("batchOrdinal", 1, 1024)
        val score = p.requiredLong("batchScore", 0, 100)
        val levelAfter = p.requiredLong("levelAfter", 1, 10_000)
        val closedAt = p.requiredLong("closedAtActiveMs", 0, 300_000)
        val claimedHash = p.requiredSha256("batchPayloadSha256")
        val projection = LinkedHashMap(p)
        projection.remove("batchPayloadSha256")
        val actualHash = CanonicalJson.sha256(projection)
        if (actualHash != claimedHash) throw AndroidStoreConflict("BATCH_CLOSED payload hash mismatch")

        rawQuery(
            "SELECT message_id,sender_seq,payload_sha256,canonical_payload FROM batch_evidence WHERE runtime_session_id=? AND batch_ordinal=?",
            arrayOf(envelope.runtimeSessionId, ordinal.toString()),
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                if (cursor.getString(0) != envelope.messageId ||
                    cursor.getLong(1) != envelope.senderSeq ||
                    cursor.getString(2) != claimedHash ||
                    !cursor.getBlob(3).contentEquals(CanonicalJson.canonicalBytes(p))
                ) throw AndroidStoreConflict("batch ordinal replay differs from first evidence")
                return
            }
        }
        if (!allowInsert) {
            throw AndroidStoreConflict("idempotent BATCH_CLOSED replay is missing durable batch evidence")
        }
        execSQL(
            "INSERT INTO batch_evidence(runtime_session_id,batch_ordinal,message_id,sender_seq,payload_sha256,canonical_payload,batch_score,level_after,closed_at_active_ms,received_at_uptime_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
            arrayOf(
                envelope.runtimeSessionId,
                ordinal,
                envelope.messageId,
                envelope.senderSeq,
                claimedHash,
                CanonicalJson.canonicalBytes(p),
                score,
                levelAfter,
                closedAt,
                receivedAtUptimeMs,
            ),
        )
    }

    private fun SQLiteDatabase.reconcileBatchesTx(
        runtimeSessionId: String,
        gamePayload: Map<String, Any?>,
    ): CommonPayloadValidationSummary {
        val prepared = rawQuery(
            "SELECT game_code,runtime_config_hash,planned_batch_count,session_start_level,duration_ms " +
                "FROM runtime_session WHERE runtime_session_id=?",
            arrayOf(runtimeSessionId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) throw AndroidStoreConflict("runtime missing")
            PreparedRuntimeFacts(
                gameCode = cursor.getString(0),
                runtimeConfigHash = cursor.getString(1),
                plannedBatchCount = cursor.getLong(2),
                sessionStartLevel = cursor.getLong(3),
                durationMs = cursor.getLong(4),
            )
        }
        val durable = ArrayList<DurableBatchEvidence>()
        rawQuery(
            "SELECT batch_ordinal,payload_sha256,canonical_payload FROM batch_evidence " +
                "WHERE runtime_session_id=? ORDER BY batch_ordinal",
            arrayOf(runtimeSessionId),
        ).use { cursor ->
            if (cursor.moveToFirst()) do {
                durable += DurableBatchEvidence(
                    batchOrdinal = cursor.getLong(0),
                    payloadSha256 = cursor.getString(1),
                    canonicalPayload = cursor.getBlob(2),
                )
            } while (cursor.moveToNext())
        }
        return try {
            CommonGamePayloadValidator.validate(gamePayload, prepared, durable)
        } catch (error: IllegalArgumentException) {
            throw AndroidStoreConflict(error.message ?: "common game payload validation failed")
        } catch (error: IllegalStateException) {
            throw AndroidStoreConflict(error.message ?: "common game payload validation failed")
        }
    }

    private fun SQLiteDatabase.insertOutboxTx(
        envelope: RuntimeWireEnvelope,
        canonicalJson: ByteArray,
        nowUtcMs: Long,
        priority: String,
    ) {
        require(envelope.senderRole == "ANDROID_CONTROLLER") { "controller outbox only accepts Android messages" }
        rawQuery(
            "SELECT runtime_session_id,sender_role,sender_seq FROM controller_event_inbox WHERE message_id=?",
            arrayOf(envelope.messageId),
        ).use { cursor ->
            if (cursor.moveToFirst()) throw AndroidStoreConflict("outbox messageId already belongs to event inbox")
        }
        rawQuery(
            "SELECT message_id FROM controller_event_inbox WHERE runtime_session_id=? AND sender_role='ANDROID_CONTROLLER' AND sender_seq=?",
            arrayOf(envelope.runtimeSessionId, envelope.senderSeq.toString()),
        ).use { cursor ->
            if (cursor.moveToFirst()) throw AndroidStoreConflict("outbox senderSeq already belongs to Android event inbox")
        }
        val senderCursor = rawQuery(
            "SELECT last_seq,last_sent_at_uptime_ms FROM sender_sequence_ledger WHERE runtime_session_id=? AND sender_role=?",
            arrayOf(envelope.runtimeSessionId, envelope.senderRole),
        ).use { cursor ->
            if (!cursor.moveToFirst()) throw AndroidStoreConflict("outbox sender cursor missing")
            Pair(cursor.getLong(0), cursor.getLong(1))
        }
        if (senderCursor.first != envelope.senderSeq) {
            throw AndroidStoreConflict("outbox senderSeq was not reserved by the controller")
        }
        if (envelope.sentAtUptimeMs < senderCursor.second) {
            throw AndroidStoreConflict("outbox sender timestamp regressed")
        }
        execSQL(
            "UPDATE sender_sequence_ledger SET last_sent_at_uptime_ms=? WHERE runtime_session_id=? AND sender_role=? AND last_seq=?",
            arrayOf(envelope.sentAtUptimeMs, envelope.runtimeSessionId, envelope.senderRole, envelope.senderSeq),
        )
        if (changes() != 1L) throw AndroidStoreConflict("outbox sender cursor update lost race")
        execSQL(
            "INSERT INTO controller_outbox(message_id,runtime_session_id,message_type,sender_seq,correlation_id,canonical_sha256,canonical_json,priority,status,required_ack_mask,received_ack_mask,attempt_count,next_attempt_at_utc_ms,claim_owner,claim_generation,claim_until_utc_ms,last_error,created_at_utc_ms) VALUES(?,?,?,?,?,?,?,?,'PENDING',0,0,0,?,NULL,0,NULL,NULL,?)",
            arrayOf(
                envelope.messageId,
                envelope.runtimeSessionId,
                envelope.messageType,
                envelope.senderSeq,
                envelope.correlationId,
                sha256Hex(canonicalJson),
                canonicalJson,
                priority,
                nowUtcMs,
                nowUtcMs,
            ),
        )
    }

    private fun SQLiteDatabase.interruptRuntimeTx(
        runtimeSessionId: String,
        completionState: String,
        reason: String,
        observedAtUtcMs: Long,
        observedAtUptimeMs: Long,
    ) {
        execSQL(
            "INSERT INTO execution_outcome(runtime_session_id,completion_state,reason,observed_at_utc_ms,observed_at_uptime_ms) VALUES(?,?,?,?,?)",
            arrayOf(runtimeSessionId, completionState, reason, observedAtUtcMs, observedAtUptimeMs),
        )
        execSQL(
            "INSERT OR REPLACE INTO controller_state(runtime_session_id,completion_state,sync_state,task_slot_state,result_id,updated_at_utc_ms,updated_at_uptime_ms) VALUES(?,?,NULL,'INTERRUPTED_WAIT',NULL,?,?)",
            arrayOf(runtimeSessionId, completionState, observedAtUtcMs, observedAtUptimeMs),
        )
        execSQL(
            "UPDATE controller_outbox SET status='CANCELLED',claim_owner=NULL,claim_until_utc_ms=NULL WHERE runtime_session_id=? AND status IN ('PENDING','IN_FLIGHT')",
            arrayOf(runtimeSessionId),
        )
        execSQL(
            "UPDATE runtime_session SET lifecycle='TERMINAL',finalization_kind='OUTCOME',terminal_reason=?,updated_at_utc_ms=?,updated_at_uptime_ms=? WHERE runtime_session_id=? AND lifecycle='ACTIVE' AND finalization_kind IS NULL",
            arrayOf(reason, observedAtUtcMs, observedAtUptimeMs, runtimeSessionId),
        )
        if (changes() != 1L) throw AndroidStoreConflict("runtime interruption lost race")
    }

    private fun SQLiteDatabase.requireBoundBootEpochTx(
        monotonicEpochId: String,
        observedAtUptimeMs: Long,
    ) {
        val meta = rawQuery(
            "SELECT boot_epoch_id,last_uptime_ms FROM controller_meta WHERE singleton_id=1",
            emptyArray(),
        ).use { cursor ->
            if (!cursor.moveToFirst()) throw AndroidStoreConflict("controller_meta missing")
            Pair(if (cursor.isNull(0)) null else cursor.getString(0), cursor.getLong(1))
        }
        if (meta.first == null) {
            throw AndroidStoreConflict("bindBootEpoch must succeed before runtime traffic")
        }
        if (meta.first != monotonicEpochId) {
            throw AndroidStoreConflict("runtime monotonic epoch differs from the bound boot epoch")
        }
        if (observedAtUptimeMs < meta.second) {
            throw AndroidStoreConflict("uptime regressed inside the bound boot epoch")
        }
        execSQL(
            "UPDATE controller_meta SET last_uptime_ms=? WHERE singleton_id=1",
            arrayOf(observedAtUptimeMs),
        )
    }

    private fun SQLiteDatabase.upsertSenderCursorTx(
        runtimeSessionId: String,
        senderRole: String,
        lastSeq: Long,
        lastSentAtUptimeMs: Long?,
        cursorExists: Boolean,
    ) {
        if (cursorExists) {
            if (lastSentAtUptimeMs == null) {
                execSQL(
                    "UPDATE sender_sequence_ledger SET last_seq=? WHERE runtime_session_id=? AND sender_role=?",
                    arrayOf(lastSeq, runtimeSessionId, senderRole),
                )
            } else {
                execSQL(
                    "UPDATE sender_sequence_ledger SET last_seq=?,last_sent_at_uptime_ms=? WHERE runtime_session_id=? AND sender_role=?",
                    arrayOf(lastSeq, lastSentAtUptimeMs, runtimeSessionId, senderRole),
                )
            }
            if (changes() != 1L) throw AndroidStoreConflict("sender cursor update lost race")
        } else {
            execSQL(
                "INSERT INTO sender_sequence_ledger(runtime_session_id,sender_role,last_seq,last_sent_at_uptime_ms) VALUES(?,?,?,?)",
                arrayOf(runtimeSessionId, senderRole, lastSeq, lastSentAtUptimeMs ?: 0L),
            )
        }
    }

    private fun SQLiteDatabase.requireActiveRuntimeTx(envelope: RuntimeWireEnvelope) {
        rawQuery(
            "SELECT system_id,device_id,task_id,task_item_id,execution_attempt,monotonic_epoch_id,package_version,core_protocol_version,lifecycle FROM runtime_session WHERE runtime_session_id=?",
            arrayOf(envelope.runtimeSessionId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) throw AndroidStoreConflict("unknown runtime")
            val actual = listOf(
                cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3),
                cursor.getLong(4).toString(), cursor.getString(5), cursor.getString(6), cursor.getString(7),
            )
            val expected = listOf(
                envelope.systemId, envelope.deviceId, envelope.taskId, envelope.taskItemId,
                envelope.executionAttempt.toString(), envelope.monotonicEpochId,
                envelope.packageVersion, envelope.coreProtocolVersion,
            )
            if (actual != expected || cursor.getString(8) != "ACTIVE") {
                throw AndroidStoreConflict("runtime identity or lifecycle mismatch")
            }
        }
    }

    private fun hasFormalResult(runtimeSessionId: String): Boolean = readableDatabase.rawQuery(
        "SELECT 1 FROM formal_training_result WHERE runtime_session_id=? LIMIT 1",
        arrayOf(runtimeSessionId),
    ).use { it.moveToFirst() }

    private fun SQLiteDatabase.runtimeLifecycle(runtimeSessionId: String): String? = rawQuery(
        "SELECT lifecycle FROM runtime_session WHERE runtime_session_id=?",
        arrayOf(runtimeSessionId),
    ).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun SQLiteDatabase.activeRuntimeIds(): List<String> {
        val out = ArrayList<String>()
        rawQuery("SELECT runtime_session_id FROM runtime_session WHERE lifecycle='ACTIVE'", emptyArray()).use { cursor ->
            if (cursor.moveToFirst()) do { out += cursor.getString(0) } while (cursor.moveToNext())
        }
        return out
    }

    private fun SQLiteDatabase.changes(): Long = rawQuery("SELECT changes()", emptyArray()).use {
        if (!it.moveToFirst()) 0 else it.getLong(0)
    }

    private fun verifyDatabase(db: SQLiteDatabase) {
        db.rawQuery("PRAGMA quick_check", emptyArray()).use { cursor ->
            if (!cursor.moveToFirst() || cursor.getString(0) != "ok") {
                throw AndroidStoreConflict("SQLite quick_check failed")
            }
        }
        db.rawQuery("PRAGMA foreign_key_check", emptyArray()).use { cursor ->
            if (cursor.moveToFirst()) throw AndroidStoreConflict("SQLite foreign_key_check failed")
        }
        db.rawQuery(
            "SELECT schema_version,profile,profile_sha256 FROM controller_meta WHERE singleton_id=1",
            emptyArray(),
        ).use { cursor ->
            if (!cursor.moveToFirst() ||
                cursor.getLong(0) != GeneratedRuntimeStoreSchema.VERSION.toLong() ||
                cursor.getString(1) != GeneratedRuntimeStoreSchema.PROFILE ||
                cursor.getString(2) != GeneratedRuntimeStoreSchema.PROFILE_SHA256
            ) throw AndroidStoreConflict("controller_meta does not match compiled storage profile")
        }
        val contradictions = listOf(
            "SELECT COUNT(*) FROM runtime_session r JOIN formal_training_result f USING(runtime_session_id) JOIN execution_outcome e USING(runtime_session_id)",
            "SELECT COUNT(*) FROM formal_training_result f LEFT JOIN result_sync_queue q USING(result_id) WHERE q.result_id IS NULL",
            "SELECT COUNT(*) FROM formal_training_result f LEFT JOIN controller_state s USING(runtime_session_id) WHERE s.result_id IS NULL OR s.completion_state!='COMPLETE' OR s.sync_state IS NULL",
            "SELECT COUNT(*) FROM formal_training_result f LEFT JOIN controller_outbox o ON o.message_id=f.ack_message_id WHERE o.message_id IS NULL OR o.message_type!='ACK_RESULT_COMMITTED'",
            "SELECT COUNT(*) FROM runtime_session r WHERE r.lifecycle='TERMINAL' AND r.finalization_kind IS NULL",
            "SELECT COUNT(*) FROM runtime_session r WHERE r.lifecycle='ACTIVE' AND (r.finalization_kind IS NOT NULL OR EXISTS(SELECT 1 FROM formal_training_result f WHERE f.runtime_session_id=r.runtime_session_id) OR EXISTS(SELECT 1 FROM execution_outcome e WHERE e.runtime_session_id=r.runtime_session_id))",
            "SELECT COUNT(*) FROM runtime_session r WHERE r.lifecycle='TERMINAL' AND r.finalization_kind='RESULT' AND NOT EXISTS(SELECT 1 FROM formal_training_result f WHERE f.runtime_session_id=r.runtime_session_id)",
            "SELECT COUNT(*) FROM runtime_session r WHERE r.lifecycle='TERMINAL' AND r.finalization_kind='OUTCOME' AND NOT EXISTS(SELECT 1 FROM execution_outcome e WHERE e.runtime_session_id=r.runtime_session_id)",
            "SELECT COUNT(*) FROM controller_state s JOIN formal_training_result f ON f.runtime_session_id=s.runtime_session_id WHERE s.completion_state='COMPLETE' AND s.result_id!=f.result_id",
            "SELECT COUNT(*) FROM controller_event_inbox i JOIN controller_outbox o ON o.message_id=i.message_id",
            "SELECT COUNT(*) FROM controller_event_inbox i JOIN controller_outbox o ON o.runtime_session_id=i.runtime_session_id AND o.sender_seq=i.sender_seq WHERE i.sender_role='ANDROID_CONTROLLER'",
            "SELECT COUNT(*) FROM controller_event_inbox i LEFT JOIN batch_evidence b ON b.message_id=i.message_id AND b.runtime_session_id=i.runtime_session_id WHERE i.message_type='BATCH_CLOSED' AND (i.sender_role!='COCOS_RUNTIME' OR b.message_id IS NULL)",
            "SELECT COUNT(*) FROM batch_evidence b LEFT JOIN controller_event_inbox i ON i.message_id=b.message_id AND i.runtime_session_id=b.runtime_session_id WHERE i.message_id IS NULL OR i.message_type!='BATCH_CLOSED' OR i.sender_role!='COCOS_RUNTIME'",
            "SELECT COUNT(*) FROM formal_training_result f LEFT JOIN controller_event_inbox i ON i.message_id=f.result_ready_message_id AND i.runtime_session_id=f.runtime_session_id WHERE i.message_id IS NULL OR i.message_type!='RESULT_READY' OR i.sender_role!='COCOS_RUNTIME'",
            "SELECT COUNT(*) FROM formal_training_result f LEFT JOIN controller_outbox o ON o.message_id=f.ack_message_id AND o.runtime_session_id=f.runtime_session_id WHERE o.message_id IS NULL OR o.message_type!='ACK_RESULT_COMMITTED' OR o.correlation_id!=f.result_ready_message_id",
            "SELECT COUNT(*) FROM sender_sequence_ledger l WHERE l.last_seq < COALESCE((SELECT MAX(i.sender_seq) FROM controller_event_inbox i WHERE i.runtime_session_id=l.runtime_session_id AND i.sender_role=l.sender_role),0)",
            "SELECT COUNT(*) FROM sender_sequence_ledger l WHERE l.sender_role='ANDROID_CONTROLLER' AND l.last_seq < COALESCE((SELECT MAX(o.sender_seq) FROM controller_outbox o WHERE o.runtime_session_id=l.runtime_session_id),0)",
        )
        contradictions.forEach { sql ->
            db.rawQuery(sql, emptyArray()).use { cursor ->
                if (!cursor.moveToFirst() || cursor.getLong(0) != 0L) {
                    throw AndroidStoreConflict("durability invariant failed: $sql")
                }
            }
        }
    }

    private fun requireSameExecutionIdentity(left: RuntimeWireEnvelope, right: RuntimeWireEnvelope) {
        val leftIdentity = listOf(
            left.contractVersion, left.monotonicEpochId, left.systemId, left.deviceId, left.taskId,
            left.taskItemId, left.executionAttempt.toString(), left.runtimeSessionId,
            left.packageVersion, left.coreProtocolVersion,
        )
        val rightIdentity = listOf(
            right.contractVersion, right.monotonicEpochId, right.systemId, right.deviceId, right.taskId,
            right.taskItemId, right.executionAttempt.toString(), right.runtimeSessionId,
            right.packageVersion, right.coreProtocolVersion,
        )
        require(leftIdentity == rightIdentity) { "ACK and RESULT_READY execution identity differ" }
    }

    private fun requireCanonicalEnvelope(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) {
        val parsed = RuntimeWireEnvelopeParser.parseCanonical(
            canonicalBytes = canonicalJson,
            declaredMessageType = envelope.messageType,
            declaredMessageId = envelope.messageId,
            declaredSenderSeq = envelope.senderSeq,
            expectedSenderRole = envelope.senderRole,
        )
        require(parsed == envelope) { "envelope differs from canonical bytes" }
    }

    private fun Map<String, Any?>.requiredString(name: String): String =
        (this[name] as? String)?.also { require(it.isNotBlank()) { "$name must not be blank" } }
            ?: throw AndroidStoreConflict("$name must be string")

    private fun Map<String, Any?>.requiredSha256(name: String): String = requiredString(name).also {
        require(it.matches(Regex("^[0-9a-f]{64}$"))) { "$name must be lowercase SHA-256" }
    }

    private fun Map<String, Any?>.requiredLong(name: String, min: Long, max: Long): Long =
        (this[name] as? Long)?.also { require(it in min..max) { "$name out of range" } }
            ?: throw AndroidStoreConflict("$name must be integer")

    private fun Map<*, *>.stringKeyMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        for ((key, value) in this) {
            if (key !is String) throw AndroidStoreConflict("JSON object key must be string")
            out[key] = value
        }
        return out
    }

    private fun requireId(value: String, name: String) {
        require(value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))) { "$name invalid" }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private inline fun <T> SQLiteDatabase.inTransaction(block: SQLiteDatabase.() -> T): T {
        beginTransaction()
        try {
            val value = block()
            setTransactionSuccessful()
            return value
        } finally {
            endTransaction()
        }
    }
}
