-- A620 v1 -> v4 data-preserving archive migration.
-- v1 lacks the wire identity, canonical message evidence and UTC retry facts
-- required to synthesize valid v4 active sessions. Existing rows are retained
-- under legacy_v1_*; no formal result or execution identity is invented.

-- A620_MIGRATION_STATEMENT
DROP TRIGGER IF EXISTS formal_result_rejects_execution_outcome;

-- A620_MIGRATION_STATEMENT
DROP TRIGGER IF EXISTS execution_outcome_rejects_formal_result;

-- A620_MIGRATION_STATEMENT
ALTER TABLE result_sync_queue RENAME TO legacy_v1_result_sync_queue;

-- A620_MIGRATION_STATEMENT
ALTER TABLE formal_training_result RENAME TO legacy_v1_formal_training_result;

-- A620_MIGRATION_STATEMENT
ALTER TABLE execution_outcome RENAME TO legacy_v1_execution_outcome;

-- A620_MIGRATION_STATEMENT
ALTER TABLE batch_evidence RENAME TO legacy_v1_batch_evidence;

-- A620_MIGRATION_STATEMENT
ALTER TABLE runtime_session RENAME TO legacy_v1_runtime_session;
