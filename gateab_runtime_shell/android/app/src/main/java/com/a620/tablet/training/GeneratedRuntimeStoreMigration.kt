// generated; do not edit
package com.a620.tablet.training

object GeneratedRuntimeStoreMigration {
    const val FROM_VERSION = 1
    const val TO_VERSION = 4
    const val MIGRATION_ID = "A620-ACDS-MIGRATION-1-TO-4-ARCHIVE"
    const val SQL_SHA256 = "cde9194c382dc2e82e7d6c202647d5bd69cb9c83910e7807e6f4ddecefb90040"
    val STATEMENTS: List<String> = listOf(
        """DROP TRIGGER IF EXISTS formal_result_rejects_execution_outcome;""".trimIndent(),
        """DROP TRIGGER IF EXISTS execution_outcome_rejects_formal_result;""".trimIndent(),
        """ALTER TABLE result_sync_queue RENAME TO legacy_v1_result_sync_queue;""".trimIndent(),
        """ALTER TABLE formal_training_result RENAME TO legacy_v1_formal_training_result;""".trimIndent(),
        """ALTER TABLE execution_outcome RENAME TO legacy_v1_execution_outcome;""".trimIndent(),
        """ALTER TABLE batch_evidence RENAME TO legacy_v1_batch_evidence;""".trimIndent(),
        """ALTER TABLE runtime_session RENAME TO legacy_v1_runtime_session;""".trimIndent()
    )
}
