from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
ANDROID = ROOT / "gateab_runtime_shell/android"
MIGRATION_SQL = ANDROID / "app/schemas/runtime_store_v1_to_v4.sql"
V1_SQL = ANDROID / "app/schemas/runtime_store_v1.sql"
V4_SQL = ANDROID / "app/schemas/runtime_store_v4.sql"


def migration_statements() -> list[str]:
    chunks = MIGRATION_SQL.read_text(encoding="utf-8").split("-- A620_MIGRATION_STATEMENT")
    assert "data-preserving archive migration" in chunks.pop(0)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def test_manifest_has_one_main_entry_and_non_exported_training_process() -> None:
    text = (ANDROID / "app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
    assert text.count("android.intent.category.LAUNCHER") == 1
    assert 'android:name=".A620Application"' in text
    assert 'android:name=".training.TrainingRuntimeService"' in text
    assert 'android:exported="false"' in text
    assert 'android:process=":training"' in text


def test_gradle_entry_includes_real_unit_assemble_and_lint_tasks() -> None:
    app = (ANDROID / "app/build.gradle.kts").read_text(encoding="utf-8")
    preflight = (ANDROID / "ci/android_sdk_preflight.sh").read_text(encoding="utf-8")
    assert 'versionName = "0.0.9-w1-platform-gateab"' in app
    assert 'getByName("test")' in app
    assert 'testImplementation("junit:junit:4.13.2")' in app
    for task in (":app:assembleDebug", ":app:testDebugUnitTest", ":app:lintDebug"):
        assert task in preflight
    assert "ANDROID_SDK_PREFLIGHT_BLOCKED" in preflight


def test_v1_to_v4_migration_archives_every_legacy_row_without_inventing_identity() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(V1_SQL.read_text(encoding="utf-8"))
    conn.execute("INSERT INTO runtime_session VALUES('OLD-RUN','OLD-ITEM',1,'RUNNING',10)")
    conn.execute("INSERT INTO batch_evidence VALUES('OLD-RUN',1,?,?,20)", ("a" * 64, b"batch"))
    conn.execute("INSERT INTO formal_training_result VALUES('OLD-RESULT','OLD-RUN',?,?,30)", ("b" * 64, b"result"))
    conn.execute("INSERT INTO result_sync_queue VALUES('OLD-RESULT','PENDING_UPLOAD',0,40)")
    conn.commit()

    with conn:
        for statement in migration_statements():
            conn.execute(statement)
        conn.executescript(V4_SQL.read_text(encoding="utf-8"))
        profile_sha = hashlib.sha256(
            (ROOT / "gateab_runtime_shell/normative/android_controller_store_profile.json").read_bytes()
        ).hexdigest()
        # The Kotlin generator binds the canonical JSON profile hash. The exact
        # value is covered by inherited generation tests; migration semantics are
        # the focus here.
        conn.execute(
            "INSERT INTO controller_meta VALUES(1,4,'A620-ACDS-1',?,NULL,0,0,0)",
            (profile_sha,),
        )
        conn.execute(
            "CREATE TABLE legacy_v1_migration_audit(singleton_id INTEGER PRIMARY KEY,"
            "migration_id TEXT,migration_sql_sha256 TEXT,disposition TEXT)"
        )
        conn.execute(
            "INSERT INTO legacy_v1_migration_audit VALUES(1,?,?,?)",
            ("A620-ACDS-MIGRATION-1-TO-4-ARCHIVE", hashlib.sha256(MIGRATION_SQL.read_bytes()).hexdigest(),
             "ARCHIVED_NEW_EXECUTION_ATTEMPT_REQUIRED"),
        )

    assert conn.execute("SELECT COUNT(*) FROM legacy_v1_runtime_session").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM legacy_v1_batch_evidence").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM legacy_v1_formal_training_result").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM legacy_v1_result_sync_queue").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM runtime_session").fetchone()[0] == 0
    assert conn.execute("SELECT disposition FROM legacy_v1_migration_audit").fetchone()[0] == \
        "ARCHIVED_NEW_EXECUTION_ATTEMPT_REQUIRED"


def _v4_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(V4_SQL.read_text(encoding="utf-8"))
    conn.execute("INSERT INTO controller_meta VALUES(1,4,'A620-ACDS-1',?,NULL,0,0,0)", ("a" * 64,))
    conn.execute(
        """INSERT INTO runtime_session(
        runtime_session_id,system_id,device_id,task_id,task_item_id,execution_attempt,
        monotonic_epoch_id,package_version,core_protocol_version,game_code,runtime_config_hash,
        planned_batch_count,session_start_level,duration_ms,lifecycle,finalization_kind,
        terminal_reason,prepare_message_id,prepare_canonical_json,created_at_utc_ms,
        created_at_uptime_ms,updated_at_utc_ms,updated_at_uptime_ms)
        VALUES('RUN','SYS','DEV','TASK','ITEM',1,'BOOT','1','1','MOCK',?,8,1,300000,
        'ACTIVE',NULL,NULL,'PREP',?,1000,100,1000,100)""",
        ("b" * 64, b"{}"),
    )
    conn.execute(
        "INSERT INTO controller_event_inbox VALUES('READY','RUN','RESULT_READY','COCOS_RUNTIME',1,?,?,200,201)",
        ("c" * 64, b"{}"),
    )
    conn.commit()
    return conn


@pytest.mark.parametrize("fault_after", [1, 2, 3, 4, 5])
def test_all_five_result_transaction_fault_points_roll_back(fault_after: int) -> None:
    conn = _v4_db()
    steps = [
        ("INSERT INTO formal_training_result VALUES(?,?,?,?,?,?,?,?,?)",
         ("RES","RUN","READY","d"*64,"NO_ELIGIBLE_BATCH",b"{}",2000,300,"ACK")),
        ("INSERT INTO result_sync_queue VALUES('RES','PENDING_UPLOAD',0,2000,NULL)", ()),
        ("INSERT INTO controller_state VALUES('RUN','COMPLETE','PENDING_UPLOAD','OCCUPIED','RES',2000,300)", ()),
        ("INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
         ("ACK","RUN","ACK_RESULT_COMMITTED",1,"READY","e"*64,b"{}","CRITICAL","PENDING",0,0,0,2000,None,0,None,None,2000)),
        ("UPDATE runtime_session SET lifecycle='TERMINAL',finalization_kind='RESULT',"
         "updated_at_utc_ms=2000,updated_at_uptime_ms=300 WHERE runtime_session_id='RUN'", ()),
    ]
    with pytest.raises(RuntimeError):
        with conn:
            for index, (sql, args) in enumerate(steps, 1):
                conn.execute(sql, args)
                if index == fault_after:
                    raise RuntimeError("fault injection")
    for table in ("formal_training_result", "result_sync_queue", "controller_state", "controller_outbox"):
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    assert conn.execute("SELECT lifecycle,finalization_kind FROM runtime_session").fetchone() == ("ACTIVE", None)


def test_public_wire_is_referenced_not_redefined_in_platform_sources() -> None:
    transport = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerCommandTransport.kt").read_text()
    mock = (ANDROID / "app/src/main/java/com/a620/tablet/training/DeviceShellMockGame.kt").read_text()
    assert "RuntimeWireEnvelopeParser.parseCanonical" in transport
    assert 'require(envelope.senderRole == "ANDROID_CONTROLLER")' in transport
    assert "A620-TRC-1.1" not in mock
    assert "fruit" not in mock.lower() and "signal" not in mock.lower()


def test_application_owns_private_store_and_unknown_migrations_fail_closed() -> None:
    app = (ANDROID / "app/src/main/java/com/a620/tablet/A620Application.kt").read_text()
    migration = (ANDROID / "app/src/main/java/com/a620/tablet/training/RuntimeStoreMigration.kt").read_text()
    store = (ANDROID / "app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    assert "AndroidControllerStore(context.applicationContext)" in app
    assert "store.verifyDurabilityInvariants()" in app
    assert "store.interruptActiveRuntimesOnControllerStartup" in app
    assert "another execution attempt is already owned" in app
    assert "oldVersion != GeneratedRuntimeStoreMigration.FROM_VERSION" in migration
    assert "fail closed" in migration
    assert "RuntimeStoreMigration.migrate" in store


def test_application_is_process_guarded_to_main_process() -> None:
    application = (ANDROID / "app/src/main/java/com/a620/tablet/A620Application.kt").read_text(encoding="utf-8")
    manifest = (ANDROID / "app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
    assert 'Application.getProcessName() == packageName' in application
    assert 'ownedPlatformController = PersistentPlatformController(this)' in application
    assert 'android:process=":training"' in manifest
    assert 'platform controller is unavailable outside the APK main process' in application


def test_controller_restart_and_owned_close_release_active_runtime_fail_closed() -> None:
    store = (ANDROID / "app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text(encoding="utf-8")
    client = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerRuntimeClient.kt").read_text(encoding="utf-8")
    assert 'reason = "CONTROLLER_PROCESS_RESTARTED"' in store
    assert 'activeRuntimeIds().also' in store
    assert 'recordInterruptionAndClose(reason.take(256), SystemClock.uptimeMillis())' in client
    assert 'if (becameTerminal)' in client


def test_callback_registration_serializes_reducer_rotation_on_actor() -> None:
    service = (ANDROID / "app/src/main/java/com/a620/tablet/training/TrainingRuntimeService.kt").read_text(encoding="utf-8")
    assert 'actor.submitUrgent {' in service
    assert 'completed.await(RuntimePolicy.CALLBACK_REGISTRATION_TIMEOUT_MS' in service
    assert 'val previous = sink.replace(nextSink)' in service
    assert 'CHANNEL_REPLACED_BY_NEW_BINDING' in service
    register_body = service.split('override fun registerCallback', 1)[1].split('override fun submitInline', 1)[0]
    assert register_body.index('actor.submitUrgent {') < register_body.index('val previous = sink.replace(nextSink)')
