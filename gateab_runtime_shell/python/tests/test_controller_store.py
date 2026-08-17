from __future__ import annotations
import sqlite3
import pytest
from a620_coordination import RuntimeCoordinationStore
from a620_runtime_shell import A620ControllerStore, DurabilityInvariantError, MigrationError, StoragePressure

IDENTITY={'runtimeSessionId':'r1','taskItemId':'item1','executionAttempt':1,'monotonicEpochId':'boot1','systemId':'sys','deviceId':'dev','taskId':'task'}
PREP={'gameCode':'catch-light','plannedBatchCount':2,'sessionStartLevel':1,'durationMs':300000,'runtimeConfigHash':'cfg'}

def make_store(tmp_path):
    p=tmp_path/'controller.db'; s=A620ControllerStore(p,boot_epoch_id='boot1',now_ms=10)
    s.register_prepared_runtime(identity=IDENTITY,prepare_payload=PREP,initial_snapshot={'state':'READY'},now_ms=11)
    return p,s

def batch(ord,score):
    base={'batchOrdinal':ord,'batchScore':score,'levelAfter':ord+1}
    from a620_coordination.sqlite_support import canonical_sha256
    base['batchPayloadSha256']=canonical_sha256(base)
    # controller store hashes projection without hash field; reconstruct correct value
    projection={k:v for k,v in base.items() if k!='batchPayloadSha256'}
    base['batchPayloadSha256']=canonical_sha256(projection)
    return base

def result_payload(batches): return {'eligibleBatches':batches,'sessionRawScore':sum(x['batchScore'] for x in batches)}

def test_migrates_actual_baseline5_database(tmp_path):
    p=tmp_path/'legacy.db'; RuntimeCoordinationStore(p)
    assert sqlite3.connect(p).execute('PRAGMA user_version').fetchone()[0]==0
    s=A620ControllerStore(p,boot_epoch_id='boot1',now_ms=1)
    conn=sqlite3.connect(p)
    assert conn.execute('PRAGMA user_version').fetchone()[0]==2
    assert conn.execute('SELECT migration_sha256 FROM migration_ledger WHERE target_version=2').fetchone()[0]
    conn.close(); assert s.boot_observation.action=='INITIAL_BOOT_BIND'

def test_newer_schema_and_migration_hash_drift_fail_closed(tmp_path):
    p=tmp_path/'newer.db'; RuntimeCoordinationStore(p); c=sqlite3.connect(p); c.execute('PRAGMA user_version=99'); c.commit(); c.close()
    with pytest.raises(MigrationError): A620ControllerStore(p,boot_epoch_id='b',now_ms=1)
    p2=tmp_path/'drift.db'; s=A620ControllerStore(p2,boot_epoch_id='b',now_ms=1); c=sqlite3.connect(p2); c.execute("UPDATE migration_ledger SET migration_sha256='bad' WHERE target_version=2"); c.commit(); c.close()
    with pytest.raises(MigrationError): A620ControllerStore(p2,boot_epoch_id='b',now_ms=2)

def test_boot_change_and_uptime_regression_interrupt_active_runtime(tmp_path):
    p,s=make_store(tmp_path)
    changed=A620ControllerStore(p,boot_epoch_id='boot2',now_ms=1)
    assert changed.boot_observation.action=='BOOT_EPOCH_CHANGED' and changed.boot_observation.interrupted_runtime_ids==('r1',)
    assert changed.counts()['execution_outcome']==1
    # A second active runtime in the same epoch is interrupted if uptime regresses.
    id2={**IDENTITY,'runtimeSessionId':'r2','taskItemId':'item2','executionAttempt':1,'monotonicEpochId':'boot2'}
    changed.register_prepared_runtime(identity=id2,prepare_payload=PREP,initial_snapshot={},now_ms=2)
    reg=A620ControllerStore(p,boot_epoch_id='boot2',now_ms=0)
    assert reg.boot_observation.action=='UPTIME_REGRESSION_FAIL_CLOSED' and reg.boot_observation.interrupted_runtime_ids==('r2',)

def test_batch_evidence_and_formal_result_single_transaction(tmp_path):
    p,s=make_store(tmp_path); b1=batch(1,80); b2=batch(2,90)
    s.append_batch_evidence(runtime_session_id='r1',batch_payload=b1,closed_at_active_ms=100,now_ms=101)
    s.append_batch_evidence(runtime_session_id='r1',batch_payload=b2,closed_at_active_ms=200,now_ms=201)
    receipt=s.commit_formal_result(runtime_session_id='r1',result_id='res1',result_payload=result_payload([b1,b2]),result_ready_message_id='ready1',ack_message_id='ack1',committed_at_uptime_ms=300)
    assert not receipt.idempotent_replay and receipt.result_payload_sha256
    assert s.counts()['formal_result']==s.counts()['sync_queue']==1
    assert s.counts()['controller_state']==1
    replay=s.commit_formal_result(runtime_session_id='r1',result_id='res1',result_payload=result_payload([b1,b2]),result_ready_message_id='ready1',ack_message_id='ack1',committed_at_uptime_ms=999)
    assert replay.idempotent_replay and replay.committed_at_uptime_ms==300
    s.audit_durability_invariants()

@pytest.mark.parametrize('fault',['after_formal_result','after_sync_queue','after_controller_state','after_ack_outbox','before_runtime_finalization'])
def test_result_commit_fault_injection_rolls_back_everything(tmp_path,fault):
    p,s=make_store(tmp_path); b=batch(1,80); s.append_batch_evidence(runtime_session_id='r1',batch_payload=b,closed_at_active_ms=10,now_ms=11)
    with pytest.raises(RuntimeError): s.commit_formal_result(runtime_session_id='r1',result_id='res',result_payload=result_payload([b]),result_ready_message_id='ready',ack_message_id='ack',committed_at_uptime_ms=20,fault_at=fault)
    c=s.counts(); assert c['formal_result']==c['sync_queue']==c['controller_state']==0
    assert c['outbox_message']==0
    conn=sqlite3.connect(p); assert conn.execute("SELECT lifecycle,finalization_kind FROM runtime_session WHERE runtime_session_id='r1'").fetchone()==('ACTIVE',None); conn.close()

def test_batch_evidence_substitution_and_score_mismatch_rejected(tmp_path):
    p,s=make_store(tmp_path); b=batch(1,80); s.append_batch_evidence(runtime_session_id='r1',batch_payload=b,closed_at_active_ms=10,now_ms=11)
    bad={**b,'batchScore':79}
    with pytest.raises(Exception): s.commit_formal_result(runtime_session_id='r1',result_id='res',result_payload={'eligibleBatches':[bad],'sessionRawScore':79},result_ready_message_id='ready',ack_message_id='ack',committed_at_uptime_ms=20)

def test_normal_quota_and_reserved_critical_capacity(tmp_path,monkeypatch):
    p,s=make_store(tmp_path)
    from a620_runtime_shell import controller_store as cs
    ob=cs.PROFILES['durable_storage.json']['outbox']
    monkeypatch.setitem(ob,'maxNormalMessagesPerRuntime',2); monkeypatch.setitem(ob,'maxNormalBytesPerRuntime',100000); monkeypatch.setitem(ob,'maxNormalMessagesGlobal',2); monkeypatch.setitem(ob,'maxNormalBytesGlobal',100000); monkeypatch.setitem(ob,'criticalReserveMessagesPerRuntime',1); monkeypatch.setitem(ob,'criticalReserveBytesPerRuntime',100000)
    assert s.enqueue_durable_message(runtime_session_id='r1',message_id='n1',message_type='START',message={'x':1},required_acks=[],next_attempt_ms=1,now_ms=1)
    assert s.enqueue_durable_message(runtime_session_id='r1',message_id='n2',message_type='PAUSE',message={'x':2},required_acks=[],next_attempt_ms=1,now_ms=1)
    with pytest.raises(StoragePressure): s.enqueue_durable_message(runtime_session_id='r1',message_id='n3',message_type='RESUME',message={'x':3},required_acks=[],next_attempt_ms=1,now_ms=1)
    # Result commit ACK may consume the critical reserve even when normal capacity is full.
    receipt=s.commit_formal_result(runtime_session_id='r1',result_id='res',result_payload={'eligibleBatches':[],'sessionRawScore':0},result_ready_message_id='ready',ack_message_id='ack',committed_at_uptime_ms=20)
    assert receipt.ack_message_id=='ack'

def test_non_durable_heartbeat_is_rejected(tmp_path):
    p,s=make_store(tmp_path)
    with pytest.raises(Exception): s.enqueue_durable_message(runtime_session_id='r1',message_id='h',message_type='HEARTBEAT',message={'x':1},required_acks=[],next_attempt_ms=1,now_ms=1)

def test_startup_invariant_audit_detects_removed_sync_queue(tmp_path):
    p,s=make_store(tmp_path); receipt=s.commit_formal_result(runtime_session_id='r1',result_id='res',result_payload={'eligibleBatches':[],'sessionRawScore':0},result_ready_message_id='ready',ack_message_id='ack',committed_at_uptime_ms=20)
    c=sqlite3.connect(p); c.execute('PRAGMA foreign_keys=OFF'); c.execute("DELETE FROM sync_queue WHERE result_id='res'"); c.commit(); c.close()
    with pytest.raises(DurabilityInvariantError): A620ControllerStore(p,boot_epoch_id='boot1',now_ms=21)

def test_outcome_and_formal_result_are_mutually_exclusive(tmp_path):
    p,s=make_store(tmp_path); assert s.commit_execution_outcome(runtime_session_id='r1',completion_state='INTERRUPTED',reason='CRASH',now_ms=20)
    with pytest.raises(Exception): s.commit_formal_result(runtime_session_id='r1',result_id='res',result_payload={'eligibleBatches':[],'sessionRawScore':0},result_ready_message_id='ready',ack_message_id='ack',committed_at_uptime_ms=21)
    s.audit_durability_invariants()
