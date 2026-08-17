from __future__ import annotations

import sqlite3

import pytest

from a620_coordination import (
    ClockRollback,
    PersistedDataCorruption,
    ProtocolConflict,
    RuntimeCoordinationStore,
)


def make_store(tmp_path):
    path = tmp_path / "runtime.db"
    store = RuntimeCoordinationStore(path)
    store.register_runtime(
        runtime_session_id="runtime-1",
        task_item_id="item-1",
        execution_attempt=1,
        monotonic_epoch_id="epoch-1",
        initial_snapshot={"count": 0},
        now_ms=10,
    )
    return path, store


def test_reopen_detects_snapshot_hash_corruption(tmp_path):
    path, _ = make_store(tmp_path)
    conn = sqlite3.connect(path)
    conn.execute(
        "UPDATE runtime_snapshot SET snapshot_json=? WHERE runtime_session_id='runtime-1'",
        (b'{"count":1}',),
    )
    conn.commit()
    conn.close()
    with pytest.raises(PersistedDataCorruption):
        RuntimeCoordinationStore(path)


def test_reopen_detects_outbox_bytes_corruption(tmp_path):
    path, store = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id="runtime-1",
        message_id="out-1",
        message={"type": "START"},
        required_acks=["STARTED"],
        next_attempt_ms=20,
        now_ms=11,
    )
    conn = sqlite3.connect(path)
    conn.execute("UPDATE outbox_message SET canonical_bytes=? WHERE message_id='out-1'", (b'{}',))
    conn.commit()
    conn.close()
    with pytest.raises(PersistedDataCorruption):
        RuntimeCoordinationStore(path)


def test_runtime_clock_cannot_move_backwards(tmp_path):
    _, store = make_store(tmp_path)
    store.acquire_runtime_lease(
        "runtime-1",
        "worker",
        monotonic_epoch_id="epoch-1",
        now_ms=20,
        lease_ms=100,
    )
    with pytest.raises(ClockRollback):
        store.acquire_runtime_lease(
            "runtime-1",
            "worker",
            monotonic_epoch_id="epoch-1",
            now_ms=19,
            lease_ms=100,
        )


def test_runtime_replay_must_match_initial_snapshot(tmp_path):
    _, store = make_store(tmp_path)
    with pytest.raises(ProtocolConflict):
        store.register_runtime(
            runtime_session_id="runtime-1",
            task_item_id="item-1",
            execution_attempt=1,
            monotonic_epoch_id="epoch-1",
            initial_snapshot={"count": 999},
            now_ms=11,
        )


def test_ack_arrays_are_hash_bound_and_canonical(tmp_path):
    path, store = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id="runtime-1",
        message_id="out-1",
        message={"type": "START"},
        required_acks=["STARTED"],
        next_attempt_ms=20,
        now_ms=11,
    )
    conn = sqlite3.connect(path)
    conn.execute(
        "UPDATE outbox_message SET required_acks_json=? WHERE message_id='out-1'",
        (b'["PAUSED"]',),
    )
    conn.commit()
    conn.close()
    with pytest.raises(PersistedDataCorruption):
        RuntimeCoordinationStore(path)


def test_storage_migration_is_idempotent(tmp_path):
    path, _ = make_store(tmp_path)
    first = RuntimeCoordinationStore(path).validate_integrity()
    second = RuntimeCoordinationStore(path).validate_integrity()
    assert first == second
    assert first["profile"] == "A620-SIP-1"
    assert first["schemaVersion"] == 2
