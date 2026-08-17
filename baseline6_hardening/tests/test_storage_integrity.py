from __future__ import annotations

import hashlib
import sqlite3

import pytest

from a620_coordination import (
    ClockRollback,
    PersistedDataCorruption,
    ProtocolConflict,
    RuntimeCoordinationStore,
    TerminalRuntime,
)
from a620_coordination.sqlite_support import canonical_json_bytes, connect


def make_store(tmp_path, *, now=0):
    store = RuntimeCoordinationStore(tmp_path / "runtime.db")
    store.register_runtime(
        runtime_session_id="runtime-1",
        task_item_id="item-1",
        execution_attempt=1,
        monotonic_epoch_id="epoch-1",
        initial_snapshot={"count": 0},
        now_ms=now,
    )
    return store


def test_coordination_uses_utf16_key_ordering(tmp_path):
    # Code-point order would place U+E000 first; UTF-16/JCS ordering places the
    # supplementary character (high surrogate D800) first.
    raw = canonical_json_bytes({"\ue000": 1, "\U00010000": 2})
    assert raw == '{"𐀀":2,"":1}'.encode("utf-8")


def test_snapshot_hash_corruption_is_rejected_before_use(tmp_path):
    store = make_store(tmp_path)
    conn = connect(tmp_path / "runtime.db")
    try:
        conn.execute(
            "UPDATE runtime_snapshot SET snapshot_json=? WHERE runtime_session_id='runtime-1'",
            (canonical_json_bytes({"count": 99}),),
        )
    finally:
        conn.close()
    with pytest.raises(PersistedDataCorruption):
        store.snapshot("runtime-1")
    with pytest.raises(PersistedDataCorruption):
        RuntimeCoordinationStore(tmp_path / "runtime.db")


def test_noncanonical_snapshot_is_rejected_even_with_matching_hash(tmp_path):
    store = make_store(tmp_path)
    raw = b'{"count": 0}'
    conn = connect(tmp_path / "runtime.db")
    try:
        conn.execute(
            "UPDATE runtime_snapshot SET snapshot_json=?,snapshot_sha256=? "
            "WHERE runtime_session_id='runtime-1'",
            (raw, hashlib.sha256(raw).hexdigest()),
        )
    finally:
        conn.close()
    with pytest.raises(PersistedDataCorruption):
        store.snapshot("runtime-1")


def test_clock_cannot_move_backwards_within_runtime_epoch(tmp_path):
    store = make_store(tmp_path, now=100)
    with pytest.raises(ClockRollback):
        store.acquire_runtime_lease(
            "runtime-1", "worker", monotonic_epoch_id="epoch-1",
            now_ms=99,
        )


def test_reregister_requires_same_initial_snapshot_and_active_lifecycle(tmp_path):
    store = make_store(tmp_path)
    with pytest.raises(ProtocolConflict):
        store.register_runtime(
            runtime_session_id="runtime-1", task_item_id="item-1",
            execution_attempt=1, monotonic_epoch_id="epoch-1",
            initial_snapshot={"count": 1}, now_ms=1,
        )
    store.terminalize_runtime(
        runtime_session_id="runtime-1", completion_state="INTERRUPTED",
        reason="TEST", now_ms=2,
    )
    with pytest.raises(TerminalRuntime):
        store.register_runtime(
            runtime_session_id="runtime-1", task_item_id="item-1",
            execution_attempt=1, monotonic_epoch_id="epoch-1",
            initial_snapshot={"count": 0}, now_ms=3,
        )


def test_new_attempt_in_new_epoch_can_supersede_old_high_uptime(tmp_path):
    store = make_store(tmp_path, now=1_000_000)
    store.register_runtime(
        runtime_session_id="runtime-2", task_item_id="item-1",
        execution_attempt=2, monotonic_epoch_id="epoch-2",
        initial_snapshot={"count": 0}, now_ms=10,
    )
    assert store.get_runtime("runtime-1")["lifecycle"] == "TERMINAL"
    assert store.get_runtime("runtime-2")["lifecycle"] == "ACTIVE"


def test_any_due_watchdog_beats_unrelated_ack_at_same_boundary(tmp_path):
    store = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id="runtime-1", message_id="start-1",
        message={"type": "START"}, required_acks=["STARTED"],
        next_attempt_ms=1, now_ms=1,
    )
    store.add_watchdog(
        obligation_id="heartbeat-wd", runtime_session_id="runtime-1",
        kind="HEARTBEAT_TIMEOUT", deadline_ms=100, now_ms=1,
        source_message_id=None,
    )
    with pytest.raises(TerminalRuntime):
        store.record_outbox_ack(
            message_id="start-1", ack_kind="STARTED", now_ms=100,
        )
    assert store.get_runtime("runtime-1")["lifecycle"] == "TERMINAL"


def test_null_source_watchdog_identity_is_really_unique(tmp_path):
    store = make_store(tmp_path)
    store.add_watchdog(
        obligation_id="wd-a", runtime_session_id="runtime-1",
        kind="HEARTBEAT_TIMEOUT", deadline_ms=100, now_ms=1,
    )
    with pytest.raises(ProtocolConflict):
        store.add_watchdog(
            obligation_id="wd-b", runtime_session_id="runtime-1",
            kind="HEARTBEAT_TIMEOUT", deadline_ms=101, now_ms=2,
        )


def test_integrity_checker_detects_valid_json_tampering_in_outbox(tmp_path):
    store = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id="runtime-1", message_id="m-1",
        message={"type": "START"}, required_acks=["STARTED"],
        next_attempt_ms=1, now_ms=1,
    )
    conn = connect(tmp_path / "runtime.db")
    try:
        conn.execute(
            "UPDATE outbox_message SET required_acks_json=? WHERE message_id='m-1'",
            (canonical_json_bytes(["READY"]),),
        )
    finally:
        conn.close()
    with pytest.raises(PersistedDataCorruption):
        store.validate_integrity()


def test_baseline5_schema_is_migrated_and_marked(tmp_path):
    db = tmp_path / "legacy.db"
    conn = connect(db)
    try:
        RuntimeCoordinationStore._create_schema(conn)
        raw = canonical_json_bytes({"count": 0})
        digest = hashlib.sha256(raw).hexdigest()
        conn.execute(
            "INSERT INTO runtime_session VALUES (?,?,?,?,?,?,?,?,?)",
            ("legacy-runtime", "item", 1, "epoch", "ACTIVE", None, 0, 5, 5),
        )
        conn.execute(
            "INSERT INTO runtime_snapshot VALUES (?,?,?,?,?)",
            ("legacy-runtime", 0, raw, digest, 5),
        )
    finally:
        conn.close()
    store = RuntimeCoordinationStore(db)
    report = store.validate_integrity()
    assert report["schemaVersion"] == 2
    assert store.snapshot("legacy-runtime") == {"count": 0}
