package com.a620.tablet.training

import android.database.sqlite.SQLiteDatabase

/** Only approved deployed upgrade. Unknown versions remain fail-closed. */
object RuntimeStoreMigration {
    fun migrate(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion != GeneratedRuntimeStoreMigration.FROM_VERSION ||
            newVersion != GeneratedRuntimeStoreMigration.TO_VERSION
        ) {
            throw AndroidStoreConflict(
                "no deployed migration is approved for $oldVersion->$newVersion; fail closed",
            )
        }

        GeneratedRuntimeStoreMigration.STATEMENTS.forEach(db::execSQL)
        GeneratedRuntimeStoreSchema.STATEMENTS.forEach(db::execSQL)
        db.execSQL(
            "INSERT INTO controller_meta(singleton_id,schema_version,profile,profile_sha256," +
                "boot_epoch_id,last_uptime_ms,created_at_utc_ms,updated_at_utc_ms) " +
                "VALUES(1,?,?,?,?,0,0,0)",
            arrayOf(
                GeneratedRuntimeStoreSchema.VERSION,
                GeneratedRuntimeStoreSchema.PROFILE,
                GeneratedRuntimeStoreSchema.PROFILE_SHA256,
                null,
            ),
        )
        db.execSQL(
            "CREATE TABLE legacy_v1_migration_audit(" +
                "singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1)," +
                "migration_id TEXT NOT NULL," +
                "migration_sql_sha256 TEXT NOT NULL," +
                "disposition TEXT NOT NULL CHECK(disposition=" +
                "'ARCHIVED_NEW_EXECUTION_ATTEMPT_REQUIRED'))",
        )
        db.execSQL(
            "INSERT INTO legacy_v1_migration_audit VALUES(1,?,?,?)",
            arrayOf(
                GeneratedRuntimeStoreMigration.MIGRATION_ID,
                GeneratedRuntimeStoreMigration.SQL_SHA256,
                "ARCHIVED_NEW_EXECUTION_ATTEMPT_REQUIRED",
            ),
        )
    }
}
