from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SHELL = ROOT / "gateab_runtime_shell"
SQL_PATH = SHELL / "android/app/schemas/runtime_store_v4.sql"
PROFILE_PATH = SHELL / "normative/android_controller_store_profile.json"
GENERATED_PATH = SHELL / "android/app/src/main/java/com/a620/tablet/training/GeneratedRuntimeStoreSchema.kt"


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SQL_PATH.read_text(encoding="utf-8"))
    profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    profile_sha = hashlib.sha256(
        json.dumps(profile, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    conn.execute(
        "INSERT INTO controller_meta VALUES(1,4,?,?,NULL,0,0,0)",
        (profile["profile"], profile_sha),
    )
    return conn


def insert_runtime(conn: sqlite3.Connection, runtime: str = "RUN-1", item: str = "ITEM-1", attempt: int = 1) -> None:
    conn.execute(
        """
        INSERT INTO runtime_session(
          runtime_session_id,system_id,device_id,task_id,task_item_id,execution_attempt,
          monotonic_epoch_id,package_version,core_protocol_version,game_code,runtime_config_hash,
          planned_batch_count,session_start_level,duration_ms,lifecycle,finalization_kind,
          terminal_reason,prepare_message_id,prepare_canonical_json,created_at_utc_ms,
          created_at_uptime_ms,updated_at_utc_ms,updated_at_uptime_ms
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,300000,'ACTIVE',NULL,NULL,?,?,1000,100,1000,100)
        """,
        (
            runtime,"SYS-1","DEV-1","TASK-1",item,attempt,"BOOT-1","1.0.0","CP-1",
            "CATCH_LIGHT","a"*64,8,1,f"PREP-{runtime}",b"{}",
        ),
    )


def insert_inbox_event(
    conn: sqlite3.Connection,
    message_id: str,
    message_type: str,
    sender_seq: int,
    runtime: str = "RUN-1",
    sender_role: str = "COCOS_RUNTIME",
) -> None:
    conn.execute(
        "INSERT INTO controller_event_inbox VALUES(?,?,?,?,?,?,?,?,?)",
        (message_id,runtime,message_type,sender_role,sender_seq,"c"*64,b"{}",sender_seq*10,sender_seq*10+1),
    )


def insert_result_ready_event(conn: sqlite3.Connection, runtime: str = "RUN-1", message_id: str = "READY-1") -> None:
    insert_inbox_event(conn, message_id, "RESULT_READY", 100, runtime)


def insert_event(
    conn: sqlite3.Connection,
    message_id: str,
    message_type: str,
    sender_role: str,
    sender_seq: int,
    runtime: str = "RUN-1",
    sent_at: int | None = None,
) -> None:
    sent = sender_seq * 10 + 100 if sent_at is None else sent_at
    conn.execute(
        "INSERT INTO controller_event_inbox VALUES(?,?,?,?,?,?,?,?,?)",
        (message_id, runtime, message_type, sender_role, sender_seq, "c" * 64, b"{}", sent, sent + 1),
    )


def insert_batch(conn: sqlite3.Connection, ordinal: int, score: int = 100, runtime: str = "RUN-1") -> None:
    message_id = f"B-{ordinal}"
    insert_event(conn, message_id, "BATCH_CLOSED", "COCOS_RUNTIME", ordinal, runtime)
    conn.execute(
        """
        INSERT INTO batch_evidence(
          runtime_session_id,batch_ordinal,message_id,sender_seq,payload_sha256,
          canonical_payload,batch_score,level_after,closed_at_active_ms,received_at_uptime_ms
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        """,
        (runtime,ordinal,message_id,ordinal,"b"*64,b"{}",score,ordinal+1,ordinal*37500,ordinal*37500+100),
    )


def insert_result_ready_event(conn: sqlite3.Connection, message_id: str = "READY-1", sender_seq: int = 20) -> None:
    insert_event(conn, message_id, "RESULT_READY", "COCOS_RUNTIME", sender_seq)


def test_profile_and_generated_schema_are_bound() -> None:
    profile = json.loads(PROFILE_PATH.read_text())
    generated = GENERATED_PATH.read_text()
    assert profile["profile"] == "A620-ACDS-1"
    assert profile["schemaVersion"] == 4
    assert 'const val PROFILE = "A620-ACDS-1"' in generated
    assert "const val VERSION = 4" in generated
    assert hashlib.sha256(SQL_PATH.read_bytes()).hexdigest() in generated


def test_one_active_runtime_is_global_and_attempt_identity_is_unique() -> None:
    conn = db(); insert_runtime(conn)
    with pytest.raises(sqlite3.IntegrityError):
        insert_runtime(conn, runtime="RUN-2", item="ITEM-2", attempt=1)
    conn.execute("UPDATE runtime_session SET lifecycle='TERMINAL',finalization_kind='OUTCOME' WHERE runtime_session_id='RUN-1'")
    insert_runtime(conn, runtime="RUN-2", item="ITEM-2", attempt=1)
    with pytest.raises(sqlite3.IntegrityError):
        insert_runtime(conn, runtime="RUN-3", item="ITEM-2", attempt=1)


def test_sender_sequences_are_scoped_by_role_not_shared_globally() -> None:
    conn = db(); insert_runtime(conn)
    for role, mid in (("ANDROID_CONTROLLER","A-1"),("COCOS_RUNTIME","C-1")):
        conn.execute(
            "INSERT INTO controller_event_inbox VALUES(?,?,?,?,?,?,?,?,?)",
            (mid,"RUN-1","X",role,1,"c"*64,b"{}",100,101),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO controller_event_inbox VALUES(?,?,?,?,?,?,?,?,?)",
            ("C-2","RUN-1","X","COCOS_RUNTIME",1,"d"*64,b"{}",102,103),
        )


def test_terminal_runtime_rejects_authoritative_inbox_but_allows_late_audit() -> None:
    conn = db(); insert_runtime(conn)
    conn.execute("UPDATE runtime_session SET lifecycle='TERMINAL',finalization_kind='OUTCOME' WHERE runtime_session_id='RUN-1'")
    with pytest.raises(sqlite3.IntegrityError, match="runtime is not active"):
        conn.execute(
            "INSERT INTO controller_event_inbox VALUES(?,?,?,?,?,?,?,?,?)",
            ("LATE","RUN-1","RESULT_READY","COCOS_RUNTIME",9,"e"*64,b"{}",200,201),
        )
    conn.execute(
        "INSERT INTO late_event_audit(runtime_session_id,message_id,message_type,sender_role,sender_seq,canonical_sha256,reason,received_at_uptime_ms) VALUES(?,?,?,?,?,?,?,?)",
        ("RUN-1","LATE","RESULT_READY","COCOS_RUNTIME",9,"e"*64,"TERMINAL_RUNTIME_CALLBACK",201),
    )


def test_batch_ordinal_cannot_exceed_prepare_plan() -> None:
    conn = db(); insert_runtime(conn)
    insert_batch(conn,8)
    with pytest.raises(sqlite3.IntegrityError, match="planned batch"):
        insert_batch(conn,9)


def test_formal_result_and_execution_outcome_are_mutually_exclusive() -> None:
    conn = db(); insert_runtime(conn); insert_result_ready_event(conn, message_id="RESULT-READY")
    conn.execute(
        "INSERT INTO execution_outcome VALUES(?,?,?,?,?)",
        ("RUN-1","INTERRUPTED","CRASH",1000,200),
    )
    with pytest.raises(sqlite3.IntegrityError, match="execution outcome"):
        conn.execute(
            "INSERT INTO formal_training_result VALUES(?,?,?,?,?,?,?,?,?)",
            ("RES-1","RUN-1","RESULT-READY","f"*64,"NO_ELIGIBLE_BATCH",b"{}",1001,201,"ACK-1"),
        )


def test_result_commit_rows_can_be_one_atomic_transaction() -> None:
    conn = db(); insert_runtime(conn); insert_batch(conn,1,80); insert_result_ready_event(conn)
    with conn:
        conn.execute(
            "INSERT INTO formal_training_result VALUES(?,?,?,?,?,?,?,?,?)",
            ("RES-1","RUN-1","READY-1","f"*64,"PARTIAL_ELIGIBLE_BATCHES",b"{}",2000,300,"ACK-1"),
        )
        conn.execute("INSERT INTO result_sync_queue VALUES('RES-1','PENDING_UPLOAD',0,2000,NULL)")
        conn.execute(
            "INSERT INTO controller_state VALUES('RUN-1','COMPLETE','PENDING_UPLOAD','OCCUPIED','RES-1',2000,300)"
        )
        conn.execute(
            "INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("ACK-1","RUN-1","ACK_RESULT_COMMITTED",2,"READY-1","a"*64,b"{}","CRITICAL","PENDING",0,0,0,2000,None,0,None,None,2000),
        )
        conn.execute(
            "UPDATE runtime_session SET lifecycle='TERMINAL',finalization_kind='RESULT',updated_at_utc_ms=2000,updated_at_uptime_ms=300 WHERE runtime_session_id='RUN-1'"
        )
    assert conn.execute("SELECT COUNT(*) FROM formal_training_result").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM result_sync_queue").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM controller_outbox").fetchone()[0] == 1
    assert conn.execute("SELECT lifecycle,finalization_kind FROM runtime_session").fetchone() == ("TERMINAL","RESULT")


@pytest.mark.parametrize("fault_after", [1,2,3,4])
def test_result_commit_fault_injection_rolls_back_all_rows(fault_after: int) -> None:
    conn = db(); insert_runtime(conn); insert_result_ready_event(conn); conn.commit()
    statements = [
        ("INSERT INTO formal_training_result VALUES(?,?,?,?,?,?,?,?,?)", ("RES-1","RUN-1","READY-1","f"*64,"PARTIAL_ELIGIBLE_BATCHES",b"{}",2000,300,"ACK-1")),
        ("INSERT INTO result_sync_queue VALUES('RES-1','PENDING_UPLOAD',0,2000,NULL)", ()),
        ("INSERT INTO controller_state VALUES('RUN-1','COMPLETE','PENDING_UPLOAD','OCCUPIED','RES-1',2000,300)", ()),
        ("INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ("ACK-1","RUN-1","ACK_RESULT_COMMITTED",2,"READY-1","a"*64,b"{}","CRITICAL","PENDING",0,0,0,2000,None,0,None,None,2000)),
    ]
    with pytest.raises(RuntimeError):
        with conn:
            for i,(sql,args) in enumerate(statements,1):
                conn.execute(sql,args)
                if i == fault_after:
                    raise RuntimeError("fault")
    for table in ("formal_training_result","result_sync_queue","controller_state","controller_outbox"):
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    assert conn.execute("SELECT lifecycle FROM runtime_session").fetchone()[0] == "ACTIVE"


def test_outbox_delivery_profile_preserves_original_message_identity() -> None:
    profile = json.loads(PROFILE_PATH.read_text())
    delivery = profile["outboxDelivery"]
    assert delivery["claimClock"] == "UTC_EPOCH_MS"
    assert delivery["claimLeaseMs"] == 15_000
    assert delivery["maxClaimBatch"] == 16
    assert delivery["fenceByOwnerAndClaimGeneration"] is True
    assert delivery["retryUsesOriginalCanonicalBytes"] is True
    assert delivery["retryUsesOriginalMessageIdAndSenderSeq"] is True
    assert delivery["binderSubmissionFailureDoesNotRollbackCommittedFormalResult"] is True
    assert delivery["dispatchPreservesSenderSequence"] is True
    assert delivery["onlySmallestUnresolvedSenderSequenceCanBeClaimed"] is True
    assert delivery["futureDueRowsScheduleWakeup"] is True
    assert delivery["onewayBinderReturnIsTransportSubmissionOnly"] is True
    assert delivery["exactResultReadyReplayRequeuesOriginalCommitAck"] is True


def test_retry_deadlines_use_utc_not_uptime_across_reboot() -> None:
    schema = SQL_PATH.read_text()
    assert "next_attempt_at_utc_ms" in schema
    assert "next_attempt_at_uptime_ms" not in schema
    profile = json.loads(PROFILE_PATH.read_text())
    assert profile["clockPolicy"]["crossRebootRetryClock"] == "UTC_EPOCH_MS"
    assert profile["clockPolicy"]["neverCompareUptimeAcrossBootEpochs"] is True


def test_controller_outbox_claim_retry_and_submit_fencing() -> None:
    conn = db(); insert_runtime(conn)
    conn.execute(
        "INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("ACK-1","RUN-1","ACK_RESULT_COMMITTED",2,"READY-1","a"*64,b"{}","CRITICAL","PENDING",0,0,0,1000,None,0,None,None,1000),
    )
    with conn:
        conn.execute(
            "UPDATE controller_outbox SET status='IN_FLIGHT',claim_owner='WORKER-1',claim_generation=1,claim_until_utc_ms=2000 WHERE message_id='ACK-1' AND status='PENDING'"
        )
    assert conn.execute(
        "SELECT status,claim_owner,claim_generation FROM controller_outbox WHERE message_id='ACK-1'"
    ).fetchone() == ("IN_FLIGHT","WORKER-1",1)
    with conn:
        conn.execute(
            "UPDATE controller_outbox SET status='PENDING',attempt_count=attempt_count+1,next_attempt_at_utc_ms=2500,claim_owner=NULL,claim_until_utc_ms=NULL,last_error='binder unavailable' WHERE message_id='ACK-1' AND status='IN_FLIGHT' AND claim_owner='WORKER-1' AND claim_generation=1"
        )
    assert conn.execute(
        "SELECT status,attempt_count,next_attempt_at_utc_ms,last_error FROM controller_outbox"
    ).fetchone() == ("PENDING",1,2500,"binder unavailable")
    with conn:
        conn.execute(
            "UPDATE controller_outbox SET status='IN_FLIGHT',claim_owner='WORKER-2',claim_generation=2,claim_until_utc_ms=4000,last_error=NULL WHERE message_id='ACK-1' AND status='PENDING'"
        )
        conn.execute(
            "UPDATE controller_outbox SET status='ACKED',attempt_count=attempt_count+1,claim_owner=NULL,claim_until_utc_ms=NULL WHERE message_id='ACK-1' AND status='IN_FLIGHT' AND claim_owner='WORKER-2' AND claim_generation=2"
        )
    assert conn.execute("SELECT status,attempt_count,claim_owner FROM controller_outbox").fetchone() == ("ACKED",2,None)


def test_outbox_schema_rejects_claim_state_mismatch() -> None:
    conn = db(); insert_runtime(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("ACK-1","RUN-1","ACK_RESULT_COMMITTED",2,"READY-1","a"*64,b"{}","CRITICAL","PENDING",0,0,0,1000,"OWNER",1,2000,None,1000),
        )


def test_android_source_wires_store_batch_reconciliation_and_ack_outbox() -> None:
    source = (SHELL / "android/app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    sink = (SHELL / "android/app/src/main/java/com/a620/tablet/training/DurableControllerEventSink.kt").read_text()
    factory = (SHELL / "android/app/src/main/java/com/a620/tablet/training/ControllerRuntimeFactory.kt").read_text()
    assert "reconcileBatchesTx" in source
    assert "INSERT INTO formal_training_result" in source
    assert "INSERT INTO result_sync_queue" in source
    assert "insertOutboxTx" in source
    assert "finalization_kind='RESULT'" in source
    assert source.index("INSERT INTO formal_training_result") < source.index("insertOutboxTx")
    assert "loadCommittedAck" in source and "idempotentReplay = true" in source
    dispatcher = (SHELL / "android/app/src/main/java/com/a620/tablet/training/ControllerOutboxDispatcher.kt").read_text()
    assert "ControllerResultCommitCoordinator" in sink
    assert "DurableControllerEventSink" in factory
    assert "claimDueControllerOutbox" in source
    assert "markControllerOutboxRetry" in source
    assert "ControllerOutboxDispatcher" in dispatcher
    assert "outboxDispatcher.scheduleDrain()" in sink
    assert source.count("requireBoundBootEpochTx(") >= 4
    assert "bindBootEpoch must succeed before runtime traffic" in source
    assert "ON CONFLICT" not in source
    assert "committedAtUtc" in source and "Instant.ofEpochMilli" in source


def test_batch_and_formal_rows_require_matching_authoritative_inbox_events() -> None:
    conn = db(); insert_runtime(conn)
    with pytest.raises(sqlite3.IntegrityError, match="matching COCOS BATCH_CLOSED"):
        conn.execute(
            "INSERT INTO batch_evidence VALUES(?,?,?,?,?,?,?,?,?,?)",
            ("RUN-1",1,"MISSING-B",1,"b"*64,b"{}",100,2,37500,37600),
        )
    with pytest.raises(sqlite3.IntegrityError, match="matching COCOS RESULT_READY"):
        conn.execute(
            "INSERT INTO formal_training_result VALUES(?,?,?,?,?,?,?,?,?)",
            ("RES-1","RUN-1","MISSING-R","f"*64,"NO_ELIGIBLE_BATCH",b"{}",1000,200,"ACK-1"),
        )


def test_message_id_and_android_sender_seq_are_global_across_inbox_and_outbox() -> None:
    conn = db(); insert_runtime(conn)
    insert_event(conn, "ANDROID-IN-1", "PREPARE", "ANDROID_CONTROLLER", 1)
    with pytest.raises(sqlite3.IntegrityError, match="sender sequence"):
        conn.execute(
            "INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("OUT-OTHER","RUN-1","ACK_RESULT_COMMITTED",1,"R-1","a"*64,b"{}","CRITICAL","PENDING",0,0,0,1000,None,0,None,None,1000),
        )
    conn.execute(
        "INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("OUT-2","RUN-1","ACK_RESULT_COMMITTED",2,"R-1","a"*64,b"{}","CRITICAL","PENDING",0,0,0,1000,None,0,None,None,1000),
    )
    with pytest.raises(sqlite3.IntegrityError, match="message id"):
        insert_event(conn, "OUT-2", "HEARTBEAT", "COCOS_RUNTIME", 2)


def test_inbox_rejects_receive_time_before_sender_time_and_invalid_quality_flag() -> None:
    conn = db(); insert_runtime(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO controller_event_inbox VALUES(?,?,?,?,?,?,?,?,?)",
            ("TIME-BACK","RUN-1","HEARTBEAT","COCOS_RUNTIME",1,"c"*64,b"{}",500,499),
        )
    insert_result_ready_event(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO formal_training_result VALUES(?,?,?,?,?,?,?,?,?)",
            ("RES-1","RUN-1","READY-1","f"*64,"GAME_SUPPLIED_FLAG",b"{}",1000,200,"ACK-1"),
        )


def test_source_requires_exact_committed_replay_and_batch_replay_evidence() -> None:
    source = (SHELL / "android/app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    replay = (SHELL / "android/app/src/main/java/com/a620/tablet/training/FormalResultReplayValidator.kt").read_text()
    assert "same RESULT_READY messageId replayed with different canonical bytes" in replay
    assert source.count("FormalResultReplayValidator.requireExactReplay") >= 2
    assert "idempotent BATCH_CLOSED replay is missing durable batch evidence" in source
    assert "late message replay differs from first audited event" in source


def test_outbox_claim_is_scoped_to_one_runtime_session() -> None:
    source = (SHELL / "android/app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    dispatcher = (SHELL / "android/app/src/main/java/com/a620/tablet/training/ControllerOutboxDispatcher.kt").read_text()
    factory = (SHELL / "android/app/src/main/java/com/a620/tablet/training/ControllerRuntimeFactory.kt").read_text()
    assert "FROM controller_outbox WHERE runtime_session_id=?" in source
    assert "runtimeSessionId: String" in dispatcher
    assert "CROSS_RUNTIME_OUTBOX_CLAIM" in dispatcher
    assert "runtimeSessionId = prepareEnvelope.runtimeSessionId" in factory


def test_only_approved_v1_to_v4_upgrade_and_all_other_versions_fail_closed_in_source() -> None:
    source = (SHELL / "android/app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    migration = (SHELL / "android/app/src/main/java/com/a620/tablet/training/RuntimeStoreMigration.kt").read_text()
    generated = (SHELL / "android/app/src/main/java/com/a620/tablet/training/GeneratedRuntimeStoreMigration.kt").read_text()
    assert "RuntimeStoreMigration.migrate" in source
    assert "no deployed migration is approved" in migration
    assert "oldVersion != GeneratedRuntimeStoreMigration.FROM_VERSION" in migration
    assert "const val FROM_VERSION = 1" in generated
    assert "const val TO_VERSION = 4" in generated
    assert "database downgrade is forbidden" in source


def test_outbox_source_serializes_smallest_unresolved_sender_sequence_and_schedules_future_due() -> None:
    source = (SHELL / "android/app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    dispatcher = (SHELL / "android/app/src/main/java/com/a620/tablet/training/ControllerOutboxDispatcher.kt").read_text()
    assert "ORDER BY sender_seq,created_at_utc_ms,message_id LIMIT 1" in source
    assert "nextControllerOutboxDueAtUtcMs" in source
    assert "claimDueControllerOutbox" in dispatcher
    assert "outbox store must serialize sender sequence claims" in dispatcher
    assert "A oneway Binder return is transport submission" in dispatcher


def test_exact_result_ready_replay_reopens_same_committed_ack_row() -> None:
    source = (SHELL / "android/app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    sink = (SHELL / "android/app/src/main/java/com/a620/tablet/training/DurableControllerEventSink.kt").read_text()
    assert "requeueCommittedAckForExactResultReplay" in source
    assert "status='PENDING',next_attempt_at_utc_ms=?" in source
    assert "committed ACK was cancelled and cannot be silently resurrected" in source
    assert "replayCommittedAckIfPresent" in sink
    assert sink.index("replayCommittedAckIfPresent(envelope, canonicalJson)") < sink.index("store.persistRuntimeEvent")


def test_sql_ack_requeue_preserves_original_identity_and_bytes() -> None:
    conn = db(); insert_runtime(conn); insert_result_ready_event(conn)
    conn.execute(
        "INSERT INTO formal_training_result VALUES(?,?,?,?,?,?,?,?,?)",
        ("RES-1","RUN-1","READY-1","f"*64,"NO_ELIGIBLE_BATCH",b"RESULT",1000,200,"ACK-1"),
    )
    original = b'{"messageId":"ACK-1"}'
    conn.execute(
        "INSERT INTO controller_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("ACK-1","RUN-1","ACK_RESULT_COMMITTED",2,"READY-1",hashlib.sha256(original).hexdigest(),original,"CRITICAL","ACKED",0,0,1,1000,None,1,None,None,1000),
    )
    with conn:
        conn.execute(
            "UPDATE controller_outbox SET status='PENDING',next_attempt_at_utc_ms=?,claim_owner=NULL,claim_until_utc_ms=NULL,last_error=NULL WHERE message_id=? AND status='ACKED'",
            (900,"ACK-1"),
        )
    row = conn.execute(
        "SELECT message_id,sender_seq,canonical_json,status,next_attempt_at_utc_ms,attempt_count FROM controller_outbox"
    ).fetchone()
    assert row == ("ACK-1",2,original,"PENDING",900,1)


def test_post_commit_runtime_failure_is_audit_only_in_source() -> None:
    source = (SHELL / "android/app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    assert "POST_COMMIT_RUNTIME_FAILURE" in source
    assert "if (!hasFormalResult(runtimeSessionId)) throw conflict" in source
