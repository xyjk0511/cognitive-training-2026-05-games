// generated; do not edit
package com.a620.tablet.training

object GeneratedRuntimeStoreSchema {
    const val PROFILE = "A620-ACDS-1"
    const val PROFILE_SHA256 = "686f56c85e89f7aa1702b80358fbc18060ef3e3957b4e734e48ad96099f6bf00"
    const val SQL_SHA256 = "d6bad4e56b6349c37f554fe33b0c9e9c3894738bc4828c77af78d9b38acc25ff"
    const val VERSION = 4
    const val DATABASE_NAME = "a620-controller.db"
    const val CROSS_REBOOT_RETRY_CLOCK = "UTC_EPOCH_MS"
    val STATEMENTS: List<String> = listOf(
        """CREATE TABLE controller_meta (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 4),
    profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 64),
    profile_sha256 TEXT NOT NULL CHECK (length(profile_sha256) = 64 AND profile_sha256 NOT GLOB '*[^0-9a-f]*'),
    boot_epoch_id TEXT,
    last_uptime_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_uptime_ms >= 0),
    created_at_utc_ms INTEGER NOT NULL CHECK (created_at_utc_ms >= 0),
    updated_at_utc_ms INTEGER NOT NULL CHECK (updated_at_utc_ms >= created_at_utc_ms)
);""".trimIndent(),
        """CREATE TABLE runtime_session (
    runtime_session_id TEXT PRIMARY KEY CHECK (length(runtime_session_id) BETWEEN 1 AND 128),
    system_id TEXT NOT NULL CHECK (length(system_id) BETWEEN 1 AND 128),
    device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
    task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
    task_item_id TEXT NOT NULL CHECK (length(task_item_id) BETWEEN 1 AND 128),
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt >= 1),
    monotonic_epoch_id TEXT NOT NULL CHECK (length(monotonic_epoch_id) BETWEEN 1 AND 128),
    package_version TEXT NOT NULL CHECK (length(package_version) BETWEEN 1 AND 128),
    core_protocol_version TEXT NOT NULL CHECK (length(core_protocol_version) BETWEEN 1 AND 128),
    game_code TEXT NOT NULL CHECK (length(game_code) BETWEEN 1 AND 64),
    runtime_config_hash TEXT NOT NULL CHECK (length(runtime_config_hash) = 64 AND runtime_config_hash NOT GLOB '*[^0-9a-f]*'),
    planned_batch_count INTEGER NOT NULL CHECK (planned_batch_count BETWEEN 1 AND 1024),
    session_start_level INTEGER NOT NULL CHECK (session_start_level BETWEEN 1 AND 10000),
    duration_ms INTEGER NOT NULL CHECK (duration_ms = 300000),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE','TERMINAL')),
    finalization_kind TEXT CHECK (finalization_kind IS NULL OR finalization_kind IN ('RESULT','OUTCOME')),
    terminal_reason TEXT,
    prepare_message_id TEXT NOT NULL UNIQUE,
    prepare_canonical_json BLOB NOT NULL CHECK (length(prepare_canonical_json) > 0),
    created_at_utc_ms INTEGER NOT NULL CHECK (created_at_utc_ms >= 0),
    created_at_uptime_ms INTEGER NOT NULL CHECK (created_at_uptime_ms >= 0),
    updated_at_utc_ms INTEGER NOT NULL CHECK (updated_at_utc_ms >= created_at_utc_ms),
    updated_at_uptime_ms INTEGER NOT NULL CHECK (updated_at_uptime_ms >= 0),
    UNIQUE(task_item_id, execution_attempt),
    CHECK (
      (lifecycle='ACTIVE' AND finalization_kind IS NULL AND terminal_reason IS NULL)
      OR
      (lifecycle='TERMINAL' AND finalization_kind IS NOT NULL)
    )
);""".trimIndent(),
        """CREATE UNIQUE INDEX one_active_runtime_globally_idx
ON runtime_session(lifecycle) WHERE lifecycle='ACTIVE';""".trimIndent(),
        """CREATE TABLE sender_sequence_ledger (
    runtime_session_id TEXT NOT NULL,
    sender_role TEXT NOT NULL CHECK (sender_role IN ('ANDROID_CONTROLLER','COCOS_RUNTIME')),
    last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
    last_sent_at_uptime_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_sent_at_uptime_ms >= 0),
    PRIMARY KEY(runtime_session_id,sender_role),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);""".trimIndent(),
        """CREATE TABLE controller_event_inbox (
    message_id TEXT PRIMARY KEY CHECK (length(message_id) BETWEEN 1 AND 128),
    runtime_session_id TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (length(message_type) BETWEEN 1 AND 64),
    sender_role TEXT NOT NULL CHECK (sender_role IN ('ANDROID_CONTROLLER','COCOS_RUNTIME')),
    sender_seq INTEGER NOT NULL CHECK (sender_seq >= 1),
    canonical_sha256 TEXT NOT NULL CHECK (length(canonical_sha256) = 64 AND canonical_sha256 NOT GLOB '*[^0-9a-f]*'),
    canonical_json BLOB NOT NULL CHECK (length(canonical_json) > 0),
    sent_at_uptime_ms INTEGER NOT NULL CHECK (sent_at_uptime_ms >= 0),
    received_at_uptime_ms INTEGER NOT NULL CHECK (received_at_uptime_ms >= sent_at_uptime_ms),
    UNIQUE(runtime_session_id, sender_role, sender_seq),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);""".trimIndent(),
        """CREATE TABLE late_event_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    runtime_session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    sender_seq INTEGER NOT NULL,
    canonical_sha256 TEXT NOT NULL CHECK (length(canonical_sha256) = 64 AND canonical_sha256 NOT GLOB '*[^0-9a-f]*'),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
    received_at_uptime_ms INTEGER NOT NULL CHECK (received_at_uptime_ms >= 0),
    UNIQUE(message_id, reason),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);""".trimIndent(),
        """CREATE TABLE runtime_transport_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    runtime_session_id TEXT NOT NULL,
    message_id TEXT,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('STALE_CHANNEL','TELEMETRY_DROPPED','INFRASTRUCTURE_FAILURE','OUTBOX_CORRUPT')),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
    observed_at_utc_ms INTEGER NOT NULL CHECK (observed_at_utc_ms >= 0),
    observed_at_uptime_ms INTEGER NOT NULL CHECK (observed_at_uptime_ms >= 0),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);""".trimIndent(),
        """CREATE TABLE batch_evidence (
    runtime_session_id TEXT NOT NULL,
    batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal >= 1),
    message_id TEXT NOT NULL UNIQUE,
    sender_seq INTEGER NOT NULL CHECK (sender_seq >= 1),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
    canonical_payload BLOB NOT NULL CHECK (length(canonical_payload) > 0),
    batch_score INTEGER NOT NULL CHECK (batch_score BETWEEN 0 AND 100),
    level_after INTEGER NOT NULL CHECK (level_after BETWEEN 1 AND 10000),
    closed_at_active_ms INTEGER NOT NULL CHECK (closed_at_active_ms BETWEEN 0 AND 300000),
    received_at_uptime_ms INTEGER NOT NULL CHECK (received_at_uptime_ms >= 0),
    PRIMARY KEY(runtime_session_id,batch_ordinal),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);""".trimIndent(),
        """CREATE TABLE formal_training_result (
    result_id TEXT PRIMARY KEY CHECK (length(result_id) BETWEEN 1 AND 128),
    runtime_session_id TEXT NOT NULL UNIQUE,
    result_ready_message_id TEXT NOT NULL UNIQUE,
    result_payload_sha256 TEXT NOT NULL CHECK (length(result_payload_sha256) = 64 AND result_payload_sha256 NOT GLOB '*[^0-9a-f]*'),
    derived_quality_flag TEXT NOT NULL CHECK (derived_quality_flag IN ('COMPLETE_BATCH_SET','PARTIAL_ELIGIBLE_BATCHES','NO_ELIGIBLE_BATCH')),
    canonical_result BLOB NOT NULL CHECK (length(canonical_result) > 0),
    committed_at_utc_ms INTEGER NOT NULL CHECK (committed_at_utc_ms >= 0),
    committed_at_uptime_ms INTEGER NOT NULL CHECK (committed_at_uptime_ms >= 0),
    ack_message_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);""".trimIndent(),
        """CREATE TABLE execution_outcome (
    runtime_session_id TEXT PRIMARY KEY,
    completion_state TEXT NOT NULL CHECK (completion_state IN ('INTERRUPTED','DISCARDED')),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
    observed_at_utc_ms INTEGER NOT NULL CHECK (observed_at_utc_ms >= 0),
    observed_at_uptime_ms INTEGER NOT NULL CHECK (observed_at_uptime_ms >= 0),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);""".trimIndent(),
        """CREATE TABLE result_sync_queue (
    result_id TEXT PRIMARY KEY,
    sync_state TEXT NOT NULL CHECK (sync_state IN ('PENDING_UPLOAD','WAITING_ACK','SYNCED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at_utc_ms INTEGER NOT NULL CHECK (next_attempt_at_utc_ms >= 0),
    last_error TEXT,
    FOREIGN KEY(result_id) REFERENCES formal_training_result(result_id) ON DELETE CASCADE
);""".trimIndent(),
        """CREATE TABLE controller_outbox (
    message_id TEXT PRIMARY KEY CHECK (length(message_id) BETWEEN 1 AND 128),
    runtime_session_id TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (length(message_type) BETWEEN 1 AND 64),
    sender_seq INTEGER NOT NULL CHECK (sender_seq >= 1),
    correlation_id TEXT,
    canonical_sha256 TEXT NOT NULL CHECK (length(canonical_sha256) = 64 AND canonical_sha256 NOT GLOB '*[^0-9a-f]*'),
    canonical_json BLOB NOT NULL CHECK (length(canonical_json) > 0),
    priority TEXT NOT NULL CHECK (priority IN ('NORMAL','CRITICAL')),
    status TEXT NOT NULL CHECK (status IN ('PENDING','IN_FLIGHT','ACKED','CANCELLED')),
    required_ack_mask INTEGER NOT NULL DEFAULT 0 CHECK (required_ack_mask >= 0),
    received_ack_mask INTEGER NOT NULL DEFAULT 0 CHECK (received_ack_mask >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at_utc_ms INTEGER NOT NULL CHECK (next_attempt_at_utc_ms >= 0),
    claim_owner TEXT,
    claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
    claim_until_utc_ms INTEGER,
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 256),
    created_at_utc_ms INTEGER NOT NULL CHECK (created_at_utc_ms >= 0),
    UNIQUE(runtime_session_id,sender_seq),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT,
    CHECK ((status='IN_FLIGHT') = (claim_owner IS NOT NULL AND claim_until_utc_ms IS NOT NULL))
);""".trimIndent(),
        """CREATE TABLE controller_state (
    runtime_session_id TEXT PRIMARY KEY,
    completion_state TEXT NOT NULL CHECK (completion_state IN ('COMPLETE','INTERRUPTED','DISCARDED')),
    sync_state TEXT CHECK (sync_state IS NULL OR sync_state IN ('PENDING_UPLOAD','WAITING_ACK','SYNCED')),
    task_slot_state TEXT NOT NULL CHECK (task_slot_state IN ('IDLE','OCCUPIED','END_RECONCILING','INTERRUPTED_WAIT')),
    result_id TEXT,
    updated_at_utc_ms INTEGER NOT NULL CHECK (updated_at_utc_ms >= 0),
    updated_at_uptime_ms INTEGER NOT NULL CHECK (updated_at_uptime_ms >= 0),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT,
    FOREIGN KEY(result_id) REFERENCES formal_training_result(result_id) ON DELETE RESTRICT,
    CHECK (
      (completion_state='COMPLETE' AND result_id IS NOT NULL AND sync_state IS NOT NULL)
      OR
      (completion_state IN ('INTERRUPTED','DISCARDED') AND result_id IS NULL AND sync_state IS NULL)
    )
);""".trimIndent(),
        """CREATE TRIGGER event_requires_active_runtime
BEFORE INSERT ON controller_event_inbox
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_session
  WHERE runtime_session_id=NEW.runtime_session_id AND lifecycle='ACTIVE'
)
BEGIN
  SELECT RAISE(ABORT,'runtime is not active');
END;""".trimIndent(),
        """CREATE TRIGGER batch_ordinal_within_plan
BEFORE INSERT ON batch_evidence
WHEN NEW.batch_ordinal > (
  SELECT planned_batch_count FROM runtime_session WHERE runtime_session_id=NEW.runtime_session_id
)
BEGIN
  SELECT RAISE(ABORT,'batch ordinal exceeds planned batch count');
END;""".trimIndent(),
        """CREATE TRIGGER formal_result_rejects_execution_outcome
BEFORE INSERT ON formal_training_result
WHEN EXISTS (SELECT 1 FROM execution_outcome WHERE runtime_session_id=NEW.runtime_session_id)
BEGIN
  SELECT RAISE(ABORT,'runtime already has execution outcome');
END;""".trimIndent(),
        """CREATE TRIGGER execution_outcome_rejects_formal_result
BEFORE INSERT ON execution_outcome
WHEN EXISTS (SELECT 1 FROM formal_training_result WHERE runtime_session_id=NEW.runtime_session_id)
BEGIN
  SELECT RAISE(ABORT,'runtime already has formal result');
END;""".trimIndent(),
        """CREATE TRIGGER inbox_rejects_outbox_message_id
BEFORE INSERT ON controller_event_inbox
WHEN EXISTS (SELECT 1 FROM controller_outbox WHERE message_id=NEW.message_id)
BEGIN
  SELECT RAISE(ABORT,'message id already belongs to controller outbox');
END;""".trimIndent(),
        """CREATE TRIGGER inbox_rejects_outbox_android_sender_seq
BEFORE INSERT ON controller_event_inbox
WHEN NEW.sender_role='ANDROID_CONTROLLER' AND EXISTS (
  SELECT 1 FROM controller_outbox
  WHERE runtime_session_id=NEW.runtime_session_id AND sender_seq=NEW.sender_seq
)
BEGIN
  SELECT RAISE(ABORT,'android sender sequence already belongs to controller outbox');
END;""".trimIndent(),
        """CREATE TRIGGER outbox_rejects_inbox_message_id
BEFORE INSERT ON controller_outbox
WHEN EXISTS (SELECT 1 FROM controller_event_inbox WHERE message_id=NEW.message_id)
BEGIN
  SELECT RAISE(ABORT,'message id already belongs to controller event inbox');
END;""".trimIndent(),
        """CREATE TRIGGER outbox_rejects_inbox_android_sender_seq
BEFORE INSERT ON controller_outbox
WHEN EXISTS (
  SELECT 1 FROM controller_event_inbox
  WHERE runtime_session_id=NEW.runtime_session_id
    AND sender_role='ANDROID_CONTROLLER'
    AND sender_seq=NEW.sender_seq
)
BEGIN
  SELECT RAISE(ABORT,'android sender sequence already belongs to controller event inbox');
END;""".trimIndent(),
        """CREATE TRIGGER batch_evidence_requires_matching_inbox_event
BEFORE INSERT ON batch_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM controller_event_inbox
  WHERE message_id=NEW.message_id
    AND runtime_session_id=NEW.runtime_session_id
    AND message_type='BATCH_CLOSED'
    AND sender_role='COCOS_RUNTIME'
)
BEGIN
  SELECT RAISE(ABORT,'batch evidence requires matching COCOS BATCH_CLOSED inbox event');
END;""".trimIndent(),
        """CREATE TRIGGER formal_result_requires_matching_result_ready_event
BEFORE INSERT ON formal_training_result
WHEN NOT EXISTS (
  SELECT 1 FROM controller_event_inbox
  WHERE message_id=NEW.result_ready_message_id
    AND runtime_session_id=NEW.runtime_session_id
    AND message_type='RESULT_READY'
    AND sender_role='COCOS_RUNTIME'
)
BEGIN
  SELECT RAISE(ABORT,'formal result requires matching COCOS RESULT_READY inbox event');
END;""".trimIndent()
    )
}
