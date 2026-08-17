from __future__ import annotations

import concurrent.futures
import json
import sqlite3
import threading

import pytest

from a620_coordination import (
    ProtocolConflict, StaleFence, TerminalRuntime,
    RuntimeCoordinationStore,
)

def make_store(tmp_path):
    store = RuntimeCoordinationStore(tmp_path / 'runtime.db')
    store.register_runtime(
        runtime_session_id='runtime-1', task_item_id='item-1',
        execution_attempt=1, monotonic_epoch_id='epoch-1',
        initial_snapshot={'count': 0}, now_ms=0,
    )
    lease = store.acquire_runtime_lease(
        'runtime-1', 'worker-a', monotonic_epoch_id='epoch-1',
        now_ms=1, lease_ms=100,
    )
    return store, lease

def test_concurrent_same_message_reducer_runs_once(tmp_path):
    store, lease = make_store(tmp_path)
    barrier = threading.Barrier(2)
    count_lock = threading.Lock()
    reducer_calls = 0

    def reducer(snapshot, payload):
        nonlocal reducer_calls
        with count_lock:
            reducer_calls += 1
        return {'count': snapshot['count'] + payload['delta']}, {'accepted': True}

    def apply():
        barrier.wait()
        return store.apply_inbound_message(
            runtime_session_id='runtime-1', owner_id='worker-a',
            fence_token=lease.fence_token, now_ms=2,
            message_id='m-1', sender_role='ANDROID', sender_seq=1,
            payload={'delta': 1}, reducer=reducer,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: apply(), range(2)))
    assert reducer_calls == 1
    assert store.snapshot('runtime-1') == {'count': 1}
    assert sorted(replay for _, replay in results) == [False, True]
    assert store.quick_check() == 'ok'

def test_same_message_id_different_content_is_protocol_error(tmp_path):
    store, lease = make_store(tmp_path)
    reducer = lambda s, p: ({'count': s['count'] + p['delta']}, {'ok': True})
    store.apply_inbound_message(
        runtime_session_id='runtime-1', owner_id='worker-a', fence_token=lease.fence_token,
        now_ms=2, message_id='m-1', sender_role='ANDROID', sender_seq=1,
        payload={'delta': 1}, reducer=reducer,
    )
    with pytest.raises(ProtocolConflict):
        store.apply_inbound_message(
            runtime_session_id='runtime-1', owner_id='worker-a', fence_token=lease.fence_token,
            now_ms=3, message_id='m-1', sender_role='ANDROID', sender_seq=2,
            payload={'delta': 2}, reducer=reducer,
        )

@pytest.mark.parametrize('fault_at', ['after_inbox_insert','after_snapshot_update','before_commit'])
def test_inbound_fault_rolls_back_message_and_snapshot(tmp_path, fault_at):
    store, lease = make_store(tmp_path)
    reducer = lambda s, p: ({'count': 99}, {'ok': True})
    with pytest.raises(RuntimeError):
        store.apply_inbound_message(
            runtime_session_id='runtime-1', owner_id='worker-a', fence_token=lease.fence_token,
            now_ms=2, message_id='m-fault', sender_role='ANDROID', sender_seq=1,
            payload={'delta': 1}, reducer=reducer, fault_at=fault_at,
        )
    assert store.snapshot('runtime-1') == {'count': 0}
    # Same sender sequence is still available because the entire transaction rolled back.
    store.apply_inbound_message(
        runtime_session_id='runtime-1', owner_id='worker-a', fence_token=lease.fence_token,
        now_ms=3, message_id='m-good', sender_role='ANDROID', sender_seq=1,
        payload={'delta': 1}, reducer=lambda s,p: ({'count': 1},{'ok':True}),
    )
    assert store.snapshot('runtime-1') == {'count': 1}

def test_stale_runtime_fence_cannot_commit(tmp_path):
    store, lease1 = make_store(tmp_path)
    lease2 = store.acquire_runtime_lease(
        'runtime-1', 'worker-b', monotonic_epoch_id='epoch-1', now_ms=101, lease_ms=100,
    )
    assert lease2.fence_token == lease1.fence_token + 1
    with pytest.raises(StaleFence):
        store.apply_inbound_message(
            runtime_session_id='runtime-1', owner_id='worker-a', fence_token=lease1.fence_token,
            now_ms=102, message_id='m-old', sender_role='ANDROID', sender_seq=1,
            payload={'delta':1}, reducer=lambda s,p: (s,{'ok':True}),
        )

def test_outbox_claims_are_disjoint_under_concurrency(tmp_path):
    store, _ = make_store(tmp_path)
    for i in range(20):
        store.enqueue_outbox(
            runtime_session_id='runtime-1', message_id=f'out-{i}',
            message={'type':'HEARTBEAT','i':i}, required_acks=['ACK'],
            next_attempt_ms=10, now_ms=1,
        )
    barrier = threading.Barrier(2)
    def claim(worker):
        barrier.wait()
        return store.claim_due_outbox(worker_id=worker, now_ms=10, limit=20)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a, b = list(pool.map(claim, ['sender-a','sender-b']))
    ids_a = {x.message_id for x in a}
    ids_b = {x.message_id for x in b}
    assert ids_a.isdisjoint(ids_b)
    assert len(ids_a | ids_b) == 20

def test_watchdog_wins_over_retry_at_same_millisecond(tmp_path):
    store, _ = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id='runtime-1', message_id='start-1',
        message={'type':'START'}, required_acks=['STARTED'],
        next_attempt_ms=100, now_ms=1,
    )
    store.add_watchdog(
        obligation_id='wd-1', runtime_session_id='runtime-1',
        kind='STARTED_TIMEOUT', deadline_ms=100,
        source_message_id='start-1', now_ms=1,
    )
    claimed, fired = store.dispatch_cycle(worker_id='sender', now_ms=100)
    assert claimed == []
    assert fired == ['wd-1']
    assert store.get_runtime('runtime-1')['lifecycle'] == 'TERMINAL'
    assert store.get_outbox('start-1')['status'] == 'CANCELLED'

def test_ack_before_deadline_satisfies_watchdog(tmp_path):
    store, _ = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id='runtime-1', message_id='start-1',
        message={'type':'START'}, required_acks=['STARTED'],
        next_attempt_ms=10, now_ms=1,
    )
    store.add_watchdog(
        obligation_id='wd-1', runtime_session_id='runtime-1', kind='STARTED_TIMEOUT',
        deadline_ms=100, source_message_id='start-1', now_ms=1,
    )
    assert store.record_outbox_ack(message_id='start-1', ack_kind='STARTED', now_ms=99)
    assert store.fire_due_watchdogs(now_ms=100) == []
    assert store.get_runtime('runtime-1')['lifecycle'] == 'ACTIVE'

def test_late_ack_after_watchdog_is_rejected(tmp_path):
    store, _ = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id='runtime-1', message_id='start-1',
        message={'type':'START'}, required_acks=['STARTED'],
        next_attempt_ms=10, now_ms=1,
    )
    store.add_watchdog(
        obligation_id='wd-1', runtime_session_id='runtime-1', kind='STARTED_TIMEOUT',
        deadline_ms=100, source_message_id='start-1', now_ms=1,
    )
    store.fire_due_watchdogs(now_ms=100)
    with pytest.raises(TerminalRuntime):
        store.record_outbox_ack(message_id='start-1', ack_kind='STARTED', now_ms=101)

def test_ack_at_exact_deadline_loses_to_watchdog(tmp_path):
    store, _ = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id='runtime-1', message_id='start-1',
        message={'type':'START'}, required_acks=['STARTED'],
        next_attempt_ms=10, now_ms=1,
    )
    store.add_watchdog(
        obligation_id='wd-1', runtime_session_id='runtime-1', kind='STARTED_TIMEOUT',
        deadline_ms=100, source_message_id='start-1', now_ms=1,
    )
    with pytest.raises(TerminalRuntime):
        store.record_outbox_ack(message_id='start-1', ack_kind='STARTED', now_ms=100)
    assert store.get_runtime('runtime-1')['lifecycle'] == 'TERMINAL'
    assert store.get_outbox('start-1')['status'] == 'CANCELLED'

def test_new_execution_attempt_atomically_supersedes_old_runtime(tmp_path):
    store, lease = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id='runtime-1', message_id='old-out',
        message={'type':'HEARTBEAT'}, required_acks=['ACK'],
        next_attempt_ms=1, now_ms=1,
    )
    store.register_runtime(
        runtime_session_id='runtime-2', task_item_id='item-1', execution_attempt=2,
        monotonic_epoch_id='epoch-2', initial_snapshot={'count':0}, now_ms=10,
    )
    assert store.get_runtime('runtime-1')['lifecycle'] == 'TERMINAL'
    assert store.get_outbox('old-out')['status'] == 'CANCELLED'
    with pytest.raises(TerminalRuntime):
        store.apply_inbound_message(
            runtime_session_id='runtime-1', owner_id='worker-a',
            fence_token=lease.fence_token, now_ms=11,
            message_id='late-old', sender_role='COCOS', sender_seq=1,
            payload={'delta':1}, reducer=lambda s,p: (s,{'ok':True}),
        )

def test_expired_claim_recovery_is_persistent_across_restart(tmp_path):
    path = tmp_path / 'runtime.db'
    store, _ = make_store(tmp_path)
    store.enqueue_outbox(
        runtime_session_id='runtime-1', message_id='out-1', message={'type':'PAUSE'},
        required_acks=['PAUSED'], next_attempt_ms=1, now_ms=1,
    )
    claimed = store.claim_due_outbox(worker_id='sender', now_ms=2, claim_lease_ms=10)
    assert len(claimed) == 1
    reopened = RuntimeCoordinationStore(path)
    reset, cancelled = reopened.recover_expired_claims(now_ms=12)
    assert (reset, cancelled) == (1, 0)
    assert reopened.get_outbox('out-1')['status'] == 'PENDING'
