PRAGMA foreign_keys = ON;

CREATE TABLE runtime_session (
    runtime_session_id TEXT PRIMARY KEY,
    task_item_id TEXT NOT NULL,
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt >= 1),
    state TEXT NOT NULL,
    created_at_uptime_ms INTEGER NOT NULL,
    UNIQUE(task_item_id, execution_attempt)
);

CREATE TABLE batch_evidence (
    runtime_session_id TEXT NOT NULL,
    batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal >= 1),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
    canonical_payload BLOB NOT NULL,
    closed_at_active_ms INTEGER NOT NULL CHECK (closed_at_active_ms >= 0),
    PRIMARY KEY(runtime_session_id, batch_ordinal),
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);

CREATE TABLE formal_training_result (
    result_id TEXT PRIMARY KEY,
    runtime_session_id TEXT NOT NULL UNIQUE,
    result_payload_sha256 TEXT NOT NULL CHECK (length(result_payload_sha256) = 64),
    canonical_result BLOB NOT NULL,
    committed_at_uptime_ms INTEGER NOT NULL,
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);

CREATE TABLE execution_outcome (
    runtime_session_id TEXT PRIMARY KEY,
    completion_state TEXT NOT NULL CHECK (completion_state IN ('INTERRUPTED', 'DISCARDED')),
    reason TEXT NOT NULL,
    observed_at_uptime_ms INTEGER NOT NULL,
    FOREIGN KEY(runtime_session_id) REFERENCES runtime_session(runtime_session_id) ON DELETE RESTRICT
);

CREATE TABLE result_sync_queue (
    result_id TEXT PRIMARY KEY,
    sync_state TEXT NOT NULL CHECK (sync_state IN ('PENDING_UPLOAD', 'WAITING_ACK', 'SYNCED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at_uptime_ms INTEGER NOT NULL,
    FOREIGN KEY(result_id) REFERENCES formal_training_result(result_id) ON DELETE CASCADE
);

CREATE TRIGGER formal_result_rejects_execution_outcome
BEFORE INSERT ON formal_training_result
WHEN EXISTS (
    SELECT 1 FROM execution_outcome WHERE runtime_session_id = NEW.runtime_session_id
)
BEGIN
    SELECT RAISE(ABORT, 'runtime already has execution outcome');
END;

CREATE TRIGGER execution_outcome_rejects_formal_result
BEFORE INSERT ON execution_outcome
WHEN EXISTS (
    SELECT 1 FROM formal_training_result WHERE runtime_session_id = NEW.runtime_session_id
)
BEGIN
    SELECT RAISE(ABORT, 'runtime already has formal result');
END;
