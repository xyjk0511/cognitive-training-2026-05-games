from __future__ import annotations
import json
import stat
import subprocess
import sys
import zipfile
from copy import deepcopy
from pathlib import Path
import pytest
from a620_gate0.canonical import canonical_bytes, canonical_sha256, strict_json_loads, CanonicalJsonError
from a620_gate0.flow_validator import FlowValidator, validate_flow, ValidationError
from a620_gate0.result_validator import (
    build_formal_result,
    derive_quality_flag,
    validate_formal_result,
    validate_game_payload,
)
from a620_gate0.tpkg import build_tpkg, validate_tpkg, TpkgError
from a620_gate0.mock_store import MockResultStore, CommitConflict
from a620_gate0.runtime_journal import DurableRuntimeJournal, IntakeDisposition, JournalConflict
from a620_gate0.result_validator import build_execution_outcome
from a620_gate0.controller_state import validate_controller_state_record, ControllerStateError
from jsonschema import Draft202012Validator

ROOT=Path(__file__).resolve().parents[2]
VECTORS=ROOT/'contracts/test-vectors'

def load(name): return json.loads((VECTORS/name).read_text(encoding='utf-8'))

def test_canonical_vectors():
    for vector in load('canonical_json_vectors.json'):
        assert canonical_bytes(vector['value']).decode('utf-8') == vector['canonicalUtf8']
        assert canonical_sha256(vector['value']) == vector['sha256']

def test_canonical_rejects_float_and_unsafe_int():
    with pytest.raises(CanonicalJsonError): canonical_bytes({'x':1.5})
    with pytest.raises(CanonicalJsonError): canonical_bytes({'x':2**53})


def test_strict_json_rejects_duplicate_keys_and_unpaired_surrogates():
    with pytest.raises(CanonicalJsonError):
        strict_json_loads('{"a":1,"a":2}')
    with pytest.raises(CanonicalJsonError):
        canonical_bytes({"bad":"\ud800"})

@pytest.mark.parametrize('name', ['valid_complete_flow.json','valid_pause_complete_flow.json','valid_terminated_flow.json','valid_same_time_terminate_flow.json','valid_error_flow.json'])
def test_valid_flows(name):
    obj=load(name); validate_flow(obj['messages'],obj['expectedOutcome'])

@pytest.mark.parametrize(
    'path',
    sorted(VECTORS.glob('invalid_*.json')),
    ids=lambda path: path.stem,
)
def test_invalid_flows(path):
    obj=json.loads(path.read_text(encoding='utf-8'))
    with pytest.raises(Exception):
        validate_flow(obj['messages'],'COMPLETE')

def test_quality_derivation():
    assert derive_quality_flag(8,8)=='COMPLETE_BATCH_SET'
    assert derive_quality_flag(7,8)=='PARTIAL_ELIGIBLE_BATCHES'
    assert derive_quality_flag(0,8)=='NO_ELIGIBLE_BATCH'

def test_tpkg_roundtrip_and_attacks(tmp_path):
    src=tmp_path/'src'; (src/'bundle').mkdir(parents=True); (src/'bundle/index.json').write_text('{"ok":true}\n',encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    private='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    trust=load('test_trust_store.json')
    pkg=tmp_path/'ok.tpkg'; build_tpkg(src,pkg,manifest,private)
    valid=validate_tpkg(pkg,trust); assert valid['gameCode']=='CATCH_LIGHT'

    # The same source and manifest must produce byte-identical archives.
    pkg2=tmp_path/'ok-2.tpkg'; build_tpkg(src,pkg2,manifest,private)
    assert pkg.read_bytes() == pkg2.read_bytes()

    # Duplicate entry attack.
    dup=tmp_path/'dup.tpkg'
    with zipfile.ZipFile(pkg) as zsrc, zipfile.ZipFile(dup,'w') as zout:
        for info in zsrc.infolist(): zout.writestr(info,zsrc.read(info.filename))
        with pytest.warns(UserWarning, match='Duplicate name'):
            zout.writestr('bundle/index.json',b'evil')
    with pytest.raises(TpkgError): validate_tpkg(dup,trust)

    # Path traversal attack.
    trav=tmp_path/'trav.tpkg'
    with zipfile.ZipFile(pkg) as zsrc, zipfile.ZipFile(trav,'w') as zout:
        for info in zsrc.infolist(): zout.writestr(info,zsrc.read(info.filename))
        zout.writestr('../evil.txt',b'x')
    with pytest.raises(TpkgError): validate_tpkg(trav,trust)


def test_tpkg_trust_rollback_compatibility_and_game_binding(tmp_path):
    src=tmp_path/'src'; (src/'bundle').mkdir(parents=True); (src/'bundle/index.json').write_text('{}',encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    private='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    trust=load('test_trust_store.json')
    pkg=tmp_path/'ok.tpkg'; build_tpkg(src,pkg,manifest,private)

    next_trust=deepcopy(trust); next_trust['keys'][0]['status']='NEXT'
    next_trust['keys'].append({'keyId':'ACTIVE-OTHER','status':'ACTIVE','publicKeyHex':'00'*32})
    assert validate_tpkg(pkg,next_trust,apk_version='0.1.0',expected_game_code='CATCH_LIGHT')['releaseSequence']==1

    revoked=deepcopy(trust); revoked['keys'][0]['status']='REVOKED'
    revoked['keys'].append({'keyId':'ACTIVE-OTHER','status':'ACTIVE','publicKeyHex':'00'*32})
    with pytest.raises(TpkgError,match='revoked'):
        validate_tpkg(pkg,revoked)
    with pytest.raises(TpkgError,match='minimum accepted release sequence'):
        validate_tpkg(pkg,trust,minimum_release_sequence=2)
    with pytest.raises(TpkgError,match='not compatible'):
        validate_tpkg(pkg,trust,apk_version='0.2.0')
    with pytest.raises(TpkgError,match='gameCode'):
        validate_tpkg(pkg,trust,expected_game_code='SIGNAL_STATION')


def test_tpkg_rejects_symlink_zip_bomb_and_content_tamper(tmp_path):
    src=tmp_path/'src'; (src/'bundle').mkdir(parents=True); (src/'bundle/index.json').write_text('{}',encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    private='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    trust=load('test_trust_store.json')
    pkg=tmp_path/'ok.tpkg'; build_tpkg(src,pkg,manifest,private)

    symlink=tmp_path/'symlink.tpkg'
    with zipfile.ZipFile(pkg) as zsrc, zipfile.ZipFile(symlink,'w',compression=zipfile.ZIP_DEFLATED) as zout:
        for info in zsrc.infolist(): zout.writestr(info,zsrc.read(info.filename))
        info=zipfile.ZipInfo('bundle/link',date_time=(1980,1,1,0,0,0))
        info.create_system=3; info.compress_type=zipfile.ZIP_STORED
        info.external_attr=(stat.S_IFLNK | 0o777) << 16
        zout.writestr(info,b'index.json')
    with pytest.raises(TpkgError,match='non-regular'):
        validate_tpkg(symlink,trust)

    bomb=tmp_path/'bomb.tpkg'
    with zipfile.ZipFile(pkg) as zsrc, zipfile.ZipFile(bomb,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as zout:
        for info in zsrc.infolist(): zout.writestr(info,zsrc.read(info.filename))
        zout.writestr('bundle/bomb.bin',b'0'*(1024*1024))
    with pytest.raises(TpkgError,match='compression ratio'):
        validate_tpkg(bomb,trust)

    tampered=tmp_path/'tampered.tpkg'
    with zipfile.ZipFile(pkg) as zsrc, zipfile.ZipFile(tampered,'w',compression=zipfile.ZIP_DEFLATED) as zout:
        for info in zsrc.infolist():
            data=b'changed' if info.filename=='bundle/index.json' else zsrc.read(info.filename)
            zout.writestr(info,data)
    with pytest.raises(TpkgError,match='file metadata mismatch'):
        validate_tpkg(tampered,trust)


def test_all_schemas_are_valid_draft_2020_12():
    for path in (ROOT/'contracts/schemas').glob('*.json'):
        Draft202012Validator.check_schema(json.loads(path.read_text(encoding='utf-8')))
    for path in (ROOT/'games').glob('*/schemas/*.json'):
        Draft202012Validator.check_schema(json.loads(path.read_text(encoding='utf-8')))


def test_embedded_game_payload_schemas_match_source():
    source=json.loads((ROOT/'contracts/schemas/a620_training_game_payload.schema.json').read_text(encoding='utf-8'))
    source.pop('$schema',None); source.pop('$id',None)
    runtime=json.loads((ROOT/'contracts/schemas/a620_training_runtime_message.schema.json').read_text(encoding='utf-8'))
    branch=next(b for b in runtime['oneOf'] if b.get('properties',{}).get('messageType',{}).get('const')=='RESULT_READY')
    assert branch['properties']['payload']['properties']['gamePayload']==source
    formal=json.loads((ROOT/'contracts/schemas/a620_formal_training_result.schema.json').read_text(encoding='utf-8'))
    assert formal['properties']['gamePayload']==source


def test_generated_cross_language_state_machine_sources_are_current():
    subprocess.run(
        [sys.executable, str(ROOT/'python/tools/generate_state_machine_sources.py'), '--check'],
        check=True,
        cwd=ROOT,
    )


def test_game_specific_schema_rejects_unknown_metrics():
    flow=load('valid_complete_flow.json')['messages']
    payload=next(m for m in flow if m['messageType']=='RESULT_READY')['payload']['gamePayload']
    bad=deepcopy(payload)
    bad['eligibleBatches'][0]['gameBatchMetrics']={'notH':1}
    # Re-hashing cannot bypass the game-specific schema.
    from a620_gate0.canonical import canonical_sha256
    projection=deepcopy(bad['eligibleBatches'][0]); projection.pop('batchPayloadSha256')
    bad['eligibleBatches'][0]['batchPayloadSha256']=canonical_sha256(projection)
    with pytest.raises(Exception): validate_game_payload(bad)

def test_mock_result_store_atomic_commit_and_idempotency(tmp_path):
    obj=load('valid_complete_flow.json')
    messages=obj['messages']
    prepare=next(m for m in messages if m['messageType']=='PREPARE')
    ready=next(m for m in messages if m['messageType']=='RESULT_READY')
    identity={k:ready[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','monotonicEpochId','packageVersion','coreProtocolVersion']}
    db_path=tmp_path/'result-store.db'
    store=MockResultStore(db_path)
    assert store.register_runtime_session(prepare,received_at_uptime_ms=101)
    assert not store.register_runtime_session(prepare,received_at_uptime_ms=101)
    for event in [m for m in messages if m['messageType']=='BATCH_CLOSED']:
        assert store.record_batch_event(event,received_at_uptime_ms=event['sentAtUptimeMs']+1)
    assert store.counts()=={'runtime_session':1,'batch_evidence':7,'formal_result':0,'sync_queue':0,'execution_outcome':0,'controller_state':0}
    with pytest.raises(RuntimeError):
        store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020,inject_failure_after_result=True)
    assert store.counts()=={'runtime_session':1,'batch_evidence':7,'formal_result':0,'sync_queue':0,'execution_outcome':0,'controller_state':0}
    ack=store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020)
    assert store.counts()=={'runtime_session':1,'batch_evidence':7,'formal_result':1,'sync_queue':1,'execution_outcome':0,'controller_state':1} and not ack.idempotent_replay
    store.close()

    # Reopen after controller restart: the durable PREPARE context and first
    # commit timestamp must still govern idempotent replay.
    store=MockResultStore(db_path)
    replay=store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:06:00Z',committed_at_uptime_ms=360000)
    assert replay.idempotent_replay
    assert replay.committed_at_utc=='2026-08-17T05:05:01Z' and replay.committed_at_uptime_ms==301020
    assert store.counts()=={'runtime_session':1,'batch_evidence':7,'formal_result':1,'sync_queue':1,'execution_outcome':0,'controller_state':1}

    conflicting_identity=deepcopy(identity); conflicting_identity['taskId']='TASK-OTHER'
    with pytest.raises(CommitConflict):
        store.commit_formal_result(identity=conflicting_identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:06:00Z',committed_at_uptime_ms=360000)

    changed=deepcopy(ready['payload']['gamePayload'])
    changed['runtimeConfigHash']='0'*64
    with pytest.raises(Exception):
        store.commit_formal_result(identity=identity,game_payload=changed,result_id='RES-TXN-OTHER',committed_at_utc='2026-08-17T05:06:00Z',committed_at_uptime_ms=360000)
    store.close()


def test_formal_result_is_immutable_and_excludes_mutable_platform_state():
    ready=next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType']=='RESULT_READY')
    identity={k:ready[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','monotonicEpochId','packageVersion','coreProtocolVersion']}
    result=build_formal_result(
        identity=identity,payload=ready['payload']['gamePayload'],result_id='RES-IMMUTABLE',
        saved_at_utc='2026-08-17T05:05:01Z',saved_at_uptime_ms=301020,
    )
    validate_formal_result(result)
    bad=deepcopy(result); bad['syncState']='SYNCED'
    with pytest.raises(Exception):
        validate_formal_result(bad)



def test_execution_outcome_and_controller_state_separation():
    identity={
        'systemId':'SYS-001','deviceId':'TAB-01','taskId':'TASK-001','taskItemId':'ITEM-01',
        'executionAttempt':1,'runtimeSessionId':'RUN-ERR','monotonicEpochId':'BOOT-A',
        'packageVersion':'1.5.0','coreProtocolVersion':'1.5.0',
    }
    outcome=build_execution_outcome(
        identity=identity,game_code='CATCH_LIGHT',completion_state='INTERRUPTED',
        reason_code='A620-RUNTIME-CRASH',active_elapsed_ms=1234,
        recorded_at_utc='2026-08-17T05:00:02Z',recorded_at_uptime_ms=2234,audit_snapshot={},
    )
    assert outcome['completionState']=='INTERRUPTED' and 'resultId' not in outcome

    record={
        'recordVersion':'A620-CSR-1.1','systemId':'SYS-001','deviceId':'TAB-01',
        'taskId':'TASK-001','taskItemId':'ITEM-01','executionAttempt':1,
        'runtimeSessionId':'RUN-ERR','monotonicEpochId':'BOOT-A',
        'packageVersion':'1.5.0','coreProtocolVersion':'1.5.0','contractVersion':'A620-TRC-1.1',
        'runtimeState':'ERROR','completionState':'INTERRUPTED',
        'syncState':None,'taskSlotState':'INTERRUPTED_WAIT','resultId':None,
        'updatedAtUtc':'2026-08-17T05:00:02Z','updatedAtUptimeMs':2234,
    }
    validate_controller_state_record(record)
    bad=deepcopy(record); bad['syncState']='SYNCED'
    with pytest.raises(ControllerStateError):
        validate_controller_state_record(bad)

    store=MockResultStore()
    prepare=deepcopy(next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType']=='PREPARE'))
    for field,value in identity.items(): prepare[field]=value
    prepare['messageId']='cmd-err-prepare'
    projection=deepcopy(prepare['payload']); projection.pop('runtimeConfigHash')
    prepare['payload']['runtimeConfigHash']=canonical_sha256(projection)
    store.register_runtime_session(prepare)
    stored=store.commit_execution_outcome(
        identity=identity,game_code='CATCH_LIGHT',completion_state='INTERRUPTED',
        reason_code='A620-RUNTIME-CRASH',active_elapsed_ms=1234,
        recorded_at_utc='2026-08-17T05:00:02Z',recorded_at_uptime_ms=2234,audit_snapshot={},
    )
    assert stored==outcome
    assert store.counts()=={'runtime_session':1,'batch_evidence':0,'formal_result':0,'sync_queue':0,'execution_outcome':1,'controller_state':1}
    assert store.commit_execution_outcome(
        identity=identity,game_code='CATCH_LIGHT',completion_state='INTERRUPTED',
        reason_code='A620-RUNTIME-CRASH',active_elapsed_ms=1234,
        recorded_at_utc='2026-08-17T05:00:02Z',recorded_at_uptime_ms=2234,audit_snapshot={},
    )==outcome

    ready=next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType']=='RESULT_READY')
    with pytest.raises(CommitConflict):
        store.commit_formal_result(
            identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-ILLEGAL',
            committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020,
        )


def test_manifest_rejects_invalid_version_range(tmp_path):
    src=tmp_path/'src'; (src/'bundle').mkdir(parents=True); (src/'bundle/index.json').write_text('{}',encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    manifest['minApkVersionInclusive']='1.0.0'; manifest['maxApkVersionExclusive']='1.0.0'
    private='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    trust=load('test_trust_store.json')
    pkg=tmp_path/'bad-range.tpkg'
    with pytest.raises(TpkgError):
        build_tpkg(src,pkg,manifest,private)


def test_normative_state_machine_spec_is_unambiguous_and_reachable():
    from a620_gate0.state_spec import validate_state_machine_spec, StateSpecError
    spec=json.loads((ROOT/'contracts/normative/a620_runtime_state_machine_v1.1.json').read_text(encoding='utf-8'))
    matrix=validate_state_machine_spec(spec)
    assert matrix[('RUNNING','PAUSE')]=='PAUSE_SCHEDULED'
    assert matrix[('RUNNING','BATCH_CLOSED')] is None

    overlapping=deepcopy(spec)
    overlapping['nonMutatingInputLegality']['PAUSE']=['RUNNING']
    with pytest.raises(StateSpecError,match='overlap'):
        validate_state_machine_spec(overlapping)


def test_pause_cannot_displace_same_timestamp_deadline():
    obj=load('valid_pause_complete_flow.json')
    messages=deepcopy(obj['messages'])
    start=next(m for m in messages if m['messageType']=='START')
    pause=next(m for m in messages if m['messageType']=='PAUSE')
    cutoff=start['payload']['cutoffUptimeMs']
    pause['sentAtUptimeMs']=cutoff-300
    pause['payload']['effectivePauseUptimeMs']=cutoff
    pause['payload']['pauseLeadTimeMs']=300
    pause['payload']['activeElapsedMs']=300000
    # The message remains structurally valid but must lose to DEADLINE by
    # semantic priority instead of deleting the scheduled deadline.
    with pytest.raises(ValidationError,match='strictly before'):
        validate_flow(messages,'COMPLETE')


def test_prepare_cross_field_bounds_are_enforced():
    messages=deepcopy(load('valid_complete_flow.json')['messages'])
    prepare=next(m for m in messages if m['messageType']=='PREPARE')
    prepare['payload']['sessionStartLevel']=121
    prepare['payload']['designMaxLevel']=120
    projection=deepcopy(prepare['payload']); projection.pop('runtimeConfigHash')
    prepare['payload']['runtimeConfigHash']=canonical_sha256(projection)
    with pytest.raises(Exception):
        validate_flow(messages,'COMPLETE')



def test_durable_runtime_journal_survives_restart_and_isolates_stale_messages(tmp_path):
    messages=load('valid_complete_flow.json')['messages']
    prepare=next(m for m in messages if m['messageType']=='PREPARE')
    identity={k:prepare[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','packageVersion','coreProtocolVersion','monotonicEpochId']}
    path=tmp_path/'journal.db'

    journal=DurableRuntimeJournal(path)
    journal.activate(identity)
    first=journal.ingest(prepare)
    assert first.disposition is IntakeDisposition.NEW
    reducer=FlowValidator(); reducer.process(prepare)
    checkpoint=reducer.snapshot()
    journal.save_snapshot(identity,checkpoint)
    journal.close()

    journal=DurableRuntimeJournal(path)
    replay=journal.ingest(prepare)
    assert replay.disposition is IntakeDisposition.IDEMPOTENT_REPLAY
    assert replay.original_disposition is IntakeDisposition.NEW
    loaded=journal.load_snapshot(identity['runtimeSessionId'])
    assert loaded is not None and loaded['state']=='PREPARING'
    assert FlowValidator.from_snapshot(loaded).identity==identity

    conflicting=deepcopy(prepare); conflicting['sentAtUptimeMs']+=1
    with pytest.raises(JournalConflict,match='different canonical content'):
        journal.ingest(conflicting)

    # New execution/boot epoch becomes active. A first-seen message from the
    # old runtime is durable audit evidence but must never advance its cursor.
    new_identity=deepcopy(identity)
    new_identity['executionAttempt']=2
    new_identity['runtimeSessionId']='RUN-002'
    new_identity['monotonicEpochId']='BOOT-B'
    reused_session=deepcopy(new_identity); reused_session['runtimeSessionId']=identity['runtimeSessionId']
    with pytest.raises(JournalConflict,match='runtimeSessionId'):
        journal.activate(reused_session,replace=True)
    non_increasing=deepcopy(new_identity); non_increasing['executionAttempt']=1
    with pytest.raises(JournalConflict,match='strictly increase'):
        journal.activate(non_increasing,replace=True)
    journal.activate(new_identity,replace=True)
    old_event=next(m for m in messages if m['messageType']=='BATCH_CLOSED')
    stale=journal.ingest(old_event)
    assert stale.disposition is IntakeDisposition.STALE_AUDIT_ONLY

    new_prepare=deepcopy(prepare)
    for field,value in new_identity.items(): new_prepare[field]=value
    new_prepare['messageId']='cmd-new-prepare'
    new_prepare['senderSeq']=1
    new_prepare['sentAtUptimeMs']=10
    accepted=journal.ingest(new_prepare)
    assert accepted.disposition is IntakeDisposition.NEW
    wrong_checkpoint=deepcopy(checkpoint)
    wrong_checkpoint['identity']=deepcopy(identity)
    with pytest.raises(JournalConflict,match='embedded identity'):
        journal.save_snapshot(new_identity,wrong_checkpoint)
    journal.close()

    # Sender high-water marks also survive process restart.
    journal=DurableRuntimeJournal(path)
    regressed=deepcopy(new_prepare); regressed['messageId']='cmd-regressed'; regressed['senderSeq']=1
    with pytest.raises(JournalConflict,match='senderSeq'):
        journal.ingest(regressed)
    assert journal.counts()=={'active_runtime':1,'runtime_message_journal':3,'runtime_audit_chain':3,'sender_cursor':2,'reducer_snapshot':1}
    journal.close()


def test_durable_batch_evidence_requires_registered_prepare_and_exact_replay(tmp_path):
    messages=load('valid_complete_flow.json')['messages']
    event=next(m for m in messages if m['messageType']=='BATCH_CLOSED')
    store=MockResultStore(tmp_path/'evidence.db')
    with pytest.raises(CommitConflict,match='not durably registered'):
        store.record_batch_event(event,received_at_uptime_ms=event['sentAtUptimeMs']+1)
    prepare=next(m for m in messages if m['messageType']=='PREPARE')
    store.register_runtime_session(prepare)
    assert store.record_batch_event(event,received_at_uptime_ms=event['sentAtUptimeMs']+1)
    assert not store.record_batch_event(event,received_at_uptime_ms=event['sentAtUptimeMs']+99)
    different_id=deepcopy(event); different_id['messageId']='evt-b1-reissued'; different_id['senderSeq']+=100
    with pytest.raises(CommitConflict,match='conflict'):
        store.record_batch_event(different_id,received_at_uptime_ms=different_id['sentAtUptimeMs']+1)
    store.close()


def test_strict_wire_parser_rejects_duplicate_float_and_whitespace_inflation():
    from a620_gate0.wire import parse_runtime_message, WireMessageError, MESSAGE_BYTE_LIMITS
    prepare=next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType']=='PREPARE')
    raw=json.dumps(prepare,separators=(',',':')).encode()
    assert parse_runtime_message(raw)['messageId']==prepare['messageId']

    duplicated=raw.replace(b'"messageId":"cmd-1"',b'"messageId":"cmd-1","messageId":"cmd-2"')
    with pytest.raises(WireMessageError,match='duplicate'):
        parse_runtime_message(duplicated)

    floated=raw.replace(b'"senderSeq":1',b'"senderSeq":1.0')
    with pytest.raises(WireMessageError):
        parse_runtime_message(floated)

    inflated=raw[:-1]+(b' '*(MESSAGE_BYTE_LIMITS['PREPARE']-len(raw)+1))+b'}'
    with pytest.raises(WireMessageError,match='PREPARE exceeds'):
        parse_runtime_message(inflated)


def test_missing_command_accepted_fails_as_soon_as_timeout_is_observable():
    messages=deepcopy(load('valid_complete_flow.json')['messages'])
    messages=[m for m in messages if not (m['messageType']=='COMMAND_ACCEPTED' and m['payload']['acceptedMessageType']=='START')]
    # The first later event makes the 100ms acceptance timeout observable.
    with pytest.raises(ValidationError,match='COMMAND_ACCEPTED timeout'):
        validate_flow(messages,'COMPLETE')


def _build_package_version(tmp_path, *, release_sequence, package_version, content):
    src=tmp_path/f'src-{release_sequence}'
    (src/'bundle').mkdir(parents=True)
    (src/'bundle/index.json').write_text(content,encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    manifest['releaseSequence']=release_sequence
    manifest['packageVersion']=package_version
    private='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    pkg=tmp_path/f'catch-light-{release_sequence}.tpkg'
    build_tpkg(src,pkg,manifest,private)
    return pkg


def test_tpkg_builder_is_atomic_and_rejects_output_inside_source(tmp_path):
    src=tmp_path/'src'; (src/'bundle').mkdir(parents=True); (src/'bundle/index.json').write_text('{}',encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    final=tmp_path/'final.tpkg'; final.write_bytes(b'known-good-old-file')
    with pytest.raises(TpkgError):
        build_tpkg(src,final,manifest,'not-a-private-key')
    assert final.read_bytes()==b'known-good-old-file'
    with pytest.raises(TpkgError,match='inside the source'):
        build_tpkg(src,src/'forbidden.tpkg',manifest,'9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
    assert not list(tmp_path.glob('.final.tpkg.*.tmp'))


def test_tpkg_rejects_archive_and_entry_comments(tmp_path):
    pkg=_build_package_version(tmp_path,release_sequence=1,package_version='1.5.0',content='{}')
    trust=load('test_trust_store.json')
    archive_comment=tmp_path/'archive-comment.tpkg'
    with zipfile.ZipFile(pkg) as src, zipfile.ZipFile(archive_comment,'w') as dst:
        dst.comment=b'covert metadata'
        for info in src.infolist(): dst.writestr(info,src.read(info.filename))
    with pytest.raises(TpkgError,match='comments'):
        validate_tpkg(archive_comment,trust)

    entry_comment=tmp_path/'entry-comment.tpkg'
    with zipfile.ZipFile(pkg) as src, zipfile.ZipFile(entry_comment,'w') as dst:
        for info in src.infolist():
            info.comment=b'covert metadata' if info.filename=='bundle/index.json' else b''
            dst.writestr(info,src.read(info.filename))
    with pytest.raises(TpkgError,match='comments'):
        validate_tpkg(entry_comment,trust)


def test_training_package_ab_slots_atomic_switch_and_recovery(tmp_path):
    from a620_gate0.package_slots import TrainingPackageSlots, PackageActivationError
    trust=load('test_trust_store.json')
    package1=_build_package_version(tmp_path,release_sequence=1,package_version='1.5.0',content='{"v":1}')
    package2=_build_package_version(tmp_path,release_sequence=2,package_version='1.5.1',content='{"v":2}')
    slots=TrainingPackageSlots(tmp_path/'installed',trust,apk_version='0.1.0')

    with pytest.raises(PackageActivationError,match='IDLE_NO_TASK'):
        slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='OCCUPIED')
    active1=slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')
    assert active1.release_sequence==1 and active1.slot=='slot-a'
    assert slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')==active1

    with pytest.raises(RuntimeError,match='injected'):
        slots.install(package2,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK',inject_failure_before_pointer=True)
    # Candidate bytes may be staged into the inactive slot, but the atomic
    # pointer still exposes the old known-good package.
    assert slots.active('CATCH_LIGHT').release_sequence==1

    # Even if the pointer is then damaged, recovery must reconstruct the
    # durable committed floor (release 1), not promote the staged but
    # uncommitted release 2 merely because it is newer.
    pointer=tmp_path/'installed/catch-light/active-package.json'
    pointer.write_bytes(b'{broken')
    recovered_before_commit=slots.recover('CATCH_LIGHT')
    assert recovered_before_commit is not None and recovered_before_commit.release_sequence==1

    active2=slots.install(package2,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')
    assert active2.release_sequence==2 and active2.slot=='slot-b'

    pointer.write_bytes(b'{broken')
    recovered=slots.recover('CATCH_LIGHT')
    assert recovered is not None and recovered.release_sequence==2

    tampered=tmp_path/'tampered-install.tpkg'; tampered.write_bytes(package2.read_bytes()+b'x')
    before=slots.active('CATCH_LIGHT')
    with pytest.raises(PackageActivationError):
        slots.install(tampered,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')
    assert slots.active('CATCH_LIGHT')==before


def test_tpkg_rejects_trailing_payload_and_malformed_trust_store(tmp_path):
    pkg=_build_package_version(tmp_path,release_sequence=1,package_version='1.5.0',content='{}')
    trust=load('test_trust_store.json')
    trailing=tmp_path/'trailing.tpkg'; trailing.write_bytes(pkg.read_bytes()+b'covert')
    with pytest.raises(TpkgError,match='trailing data'):
        validate_tpkg(trailing,trust)

    duplicate=deepcopy(trust); duplicate['keys'].append(deepcopy(duplicate['keys'][0]))
    with pytest.raises(TpkgError,match='duplicate'):
        validate_tpkg(pkg,duplicate)
    no_active=deepcopy(trust); no_active['keys'][0]['status']='REVOKED'
    with pytest.raises(TpkgError,match='exactly one ACTIVE'):
        validate_tpkg(pkg,no_active)
    invalid_min=deepcopy(trust); invalid_min['minimumAcceptedReleaseSequence']['CATCH_LIGHT']=0
    with pytest.raises(TpkgError,match='minimum release'):
        validate_tpkg(pkg,invalid_min)


def test_flow_validator_checkpoint_restore_preserves_replay_and_completion():
    obj=load('valid_pause_complete_flow.json')
    messages=obj['messages']
    split=next(index for index,message in enumerate(messages) if message['messageType']=='PAUSED')+1
    before=messages[:split]
    after=messages[split:]

    original=__import__('a620_gate0.flow_validator',fromlist=['FlowValidator']).FlowValidator()
    for message in before: original.process(message)
    snapshot=original.snapshot()
    restored=__import__('a620_gate0.flow_validator',fromlist=['FlowValidator']).FlowValidator.from_snapshot(snapshot)
    assert canonical_bytes(restored.snapshot())==canonical_bytes(snapshot)

    # Last pre-checkpoint message is an exact replay and must not mutate state.
    state_before=restored.state
    restored.process(before[-1])
    assert restored.state==state_before
    for message in after: restored.process(message)
    restored.finalize('COMPLETE')
    assert restored.state=='RESULT_COMMITTED' and restored.final_formal_result_id is not None

    tampered=deepcopy(snapshot); tampered['state']='NOT_A_STATE'
    with pytest.raises(ValidationError):
        __import__('a620_gate0.flow_validator',fromlist=['FlowValidator']).FlowValidator.from_snapshot(tampered)



def test_wire_envelope_schema_typescript_and_kotlin_fields_stay_in_lockstep():
    import re

    schema=json.loads((ROOT/'contracts/schemas/a620_training_runtime_message.schema.json').read_text(encoding='utf-8'))
    branches=schema['oneOf']
    schema_fields=set(branches[0]['properties'])
    schema_required=set(branches[0]['required'])
    assert schema_fields==schema_required
    for branch in branches[1:]:
        assert set(branch['properties'])==schema_fields
        assert set(branch['required'])==schema_required

    ts=(ROOT/'typescript/src/contracts.ts').read_text(encoding='utf-8')
    ts_body=re.search(r'export interface MessageEnvelope<[^>]+>\s*\{(?P<body>.*?)\n\}',ts,re.S)
    assert ts_body
    ts_fields=set(re.findall(r'^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:',ts_body.group('body'),re.M))

    kotlin=(ROOT/'kotlin/src/main/kotlin/a620/Dto.kt').read_text(encoding='utf-8')
    kt_body=re.search(r'data class MessageEnvelope<[^>]+>\((?P<body>.*?)\n\)',kotlin,re.S)
    assert kt_body
    kt_fields=set(re.findall(r'^\s{4}val\s+([A-Za-z][A-Za-z0-9]*)\s*:',kt_body.group('body'),re.M))

    assert ts_fields==schema_fields
    assert kt_fields==schema_fields


def test_runtime_snapshot_must_be_complete_and_bound_to_storage_key(tmp_path):
    prepare=next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType']=='PREPARE')
    identity={k:prepare[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','packageVersion','coreProtocolVersion','monotonicEpochId']}
    journal=DurableRuntimeJournal(tmp_path/'snapshot.db')
    journal.activate(identity)
    with pytest.raises(JournalConflict,match='invalid reducer snapshot'):
        journal.save_snapshot(identity,{'runtimeState':'PREPARING'})

    reducer=FlowValidator(); reducer.process(prepare)
    checkpoint=reducer.snapshot()
    journal.save_snapshot(identity,checkpoint)
    # Simulate storage-key corruption independently of the snapshot hash.
    journal.db.execute(
        'UPDATE reducer_snapshot SET runtime_session_id=? WHERE runtime_session_id=?',
        ('RUN-WRONG',identity['runtimeSessionId']),
    )
    with pytest.raises(JournalConflict,match='storage key'):
        journal.load_snapshot('RUN-WRONG')
    journal.close()


def test_active_package_replay_does_not_bypass_current_trust_policy(tmp_path):
    from a620_gate0.package_slots import TrainingPackageSlots, PackageActivationError
    trust=load('test_trust_store.json')
    package1=_build_package_version(tmp_path,release_sequence=1,package_version='1.5.0',content='{"v":1}')
    slots=TrainingPackageSlots(tmp_path/'installed',trust,apk_version='0.1.0')
    slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')

    revoked=deepcopy(trust)
    revoked['keys'][0]['status']='REVOKED'
    revoked['keys'].append({'keyId':'ACTIVE-REPLACEMENT','status':'ACTIVE','publicKeyHex':'00'*32})
    slots.trust_store=revoked
    with pytest.raises(PackageActivationError,match='active package validation failed'):
        slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')



def test_durable_runtime_apply_commits_message_cursor_and_snapshot_atomically(tmp_path):
    messages=load('valid_complete_flow.json')['messages']
    prepare=next(m for m in messages if m['messageType']=='PREPARE')
    ready=next(m for m in messages if m['messageType']=='READY')
    identity={k:prepare[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','packageVersion','coreProtocolVersion','monotonicEpochId']}
    path=tmp_path/'atomic-runtime.db'
    journal=DurableRuntimeJournal(path)
    journal.activate(identity)

    applied=journal.apply(prepare)
    assert applied.intake.disposition is IntakeDisposition.NEW
    assert applied.reducer_snapshot is not None and applied.reducer_snapshot['state']=='PREPARING'

    with pytest.raises(RuntimeError,match='injected failure'):
        journal.apply(ready,inject_failure_after_journal=True)
    assert journal.counts()=={'active_runtime':1,'runtime_message_journal':1,'runtime_audit_chain':1,'sender_cursor':1,'reducer_snapshot':1}
    assert journal.load_snapshot(identity['runtimeSessionId'])['state']=='PREPARING'

    retried=journal.apply(ready)
    assert retried.intake.disposition is IntakeDisposition.NEW
    assert retried.reducer_snapshot is not None and retried.reducer_snapshot['state']=='READY'
    journal.close()

    journal=DurableRuntimeJournal(path)
    replay=journal.apply(ready)
    assert replay.intake.disposition is IntakeDisposition.IDEMPOTENT_REPLAY
    assert replay.reducer_snapshot is not None and replay.reducer_snapshot['state']=='READY'

    newer=deepcopy(identity)
    newer['executionAttempt']=2
    newer['runtimeSessionId']='RUN-ATOMIC-2'
    newer['monotonicEpochId']='BOOT-ATOMIC-2'
    journal.activate(newer,replace=True)
    superseded_replay=journal.apply(ready)
    assert superseded_replay.intake.disposition is IntakeDisposition.IDEMPOTENT_REPLAY
    assert superseded_replay.reducer_snapshot is None
    assert journal.counts()=={'active_runtime':1,'runtime_message_journal':2,'runtime_audit_chain':2,'sender_cursor':2,'reducer_snapshot':1}
    journal.close()


def test_package_recovery_never_promotes_uncommitted_first_install(tmp_path):
    from a620_gate0.package_slots import TrainingPackageSlots
    trust=load('test_trust_store.json')
    package1=_build_package_version(tmp_path,release_sequence=1,package_version='1.5.0',content='{"v":1}')
    slots=TrainingPackageSlots(tmp_path/'installed',trust,apk_version='0.1.0')
    with pytest.raises(RuntimeError,match='injected'):
        slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK',inject_failure_before_pointer=True)
    assert slots.active('CATCH_LIGHT') is None
    assert slots.recover('CATCH_LIGHT') is None


def test_package_release_floor_blocks_old_nonactive_package(tmp_path):
    from a620_gate0.package_slots import TrainingPackageSlots, PackageActivationError
    trust=load('test_trust_store.json')
    package1=_build_package_version(tmp_path,release_sequence=1,package_version='1.5.0',content='{"v":1}')
    package2=_build_package_version(tmp_path,release_sequence=2,package_version='1.5.1',content='{"v":2}')
    slots=TrainingPackageSlots(tmp_path/'installed',trust,apk_version='0.1.0')
    slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')
    active2=slots.install(package2,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')
    with pytest.raises(PackageActivationError,match='minimum accepted release sequence'):
        slots.install(package1,expected_game_code='CATCH_LIGHT',maintenance_state='IDLE_NO_TASK')
    assert slots.active('CATCH_LIGHT')==active2


def test_json_resource_profile_rejects_depth_container_and_string_budgets():
    from a620_gate0.canonical import A620_JSON_RESOURCE_LIMITS, validate_json_resources

    deep: object = 0
    for _ in range(A620_JSON_RESOURCE_LIMITS.max_depth + 1):
        deep = [deep]
    with pytest.raises(CanonicalJsonError, match='depth'):
        validate_json_resources(deep)
    with pytest.raises(CanonicalJsonError, match='array exceeds'):
        canonical_bytes([0] * (A620_JSON_RESOURCE_LIMITS.max_array_items + 1))
    with pytest.raises(CanonicalJsonError, match='string budget'):
        canonical_bytes(['x' * 200_000] * 8)


def test_ipc_frame_fragmentation_coalescing_and_fail_closed():
    from a620_gate0.ipc_frame import (
        FrameDecoder, IpcFrameError, decode_canonical_payload, encode_frame,
        MAX_FRAME_PAYLOAD_BYTES,
    )

    frame_a = encode_frame({'a': 1})
    frame_b = encode_frame({'b': '捕光行动'})
    decoder = FrameDecoder()
    assert decoder.feed(frame_a[:1]) == []
    assert decoder.feed(frame_a[1:5]) == []
    result = decoder.feed(frame_a[5:])
    assert [decode_canonical_payload(item) for item in result] == [{'a': 1}]
    assert decoder.retained_bytes == 0
    decoder.finish()

    decoder = FrameDecoder()
    result = decoder.feed(frame_a + frame_b)
    assert [decode_canonical_payload(item) for item in result] == [{'a': 1}, {'b': '捕光行动'}]
    decoder.finish()

    decoder = FrameDecoder()
    decoder.feed(frame_b[:-1])
    with pytest.raises(IpcFrameError, match='partial frame'):
        decoder.finish()
    with pytest.raises(IpcFrameError, match='already failed'):
        decoder.feed(b'')

    with pytest.raises(IpcFrameError, match='canonical'):
        decode_canonical_payload(b'{"b":2, "a":1}')
    with pytest.raises(IpcFrameError, match='size'):
        decode_canonical_payload(b'x' * (MAX_FRAME_PAYLOAD_BYTES + 1))


def test_ipc_frame_accepts_multiple_large_frames_in_one_read_without_false_overflow():
    from a620_gate0.ipc_frame import FrameDecoder, decode_canonical_payload, encode_frame

    # Two 1.5 MiB payload frames exceed the maximum *single-frame* retained
    # size when coalesced, but must still be processed sequentially.
    value_a = {'blob': ['a' * 200_000] * 6}
    value_b = {'blob': ['b' * 200_000] * 6}
    combined = encode_frame(value_a) + encode_frame(value_b)
    decoded = FrameDecoder().feed(combined)
    assert len(decoded) == 2
    assert decode_canonical_payload(decoded[0])['blob'][0][0] == 'a'
    assert decode_canonical_payload(decoded[1])['blob'][0][0] == 'b'


def test_durable_outbox_retries_exact_bytes_and_survives_restart(tmp_path):
    from a620_gate0.durable_outbox import DurableMessageOutbox, OutboxConflict

    messages = load('valid_complete_flow.json')['messages']
    prepare = next(m for m in messages if m['messageType'] == 'PREPARE')
    ready = next(m for m in messages if m['messageType'] == 'READY')
    path = tmp_path / 'outbox.db'

    outbox = DurableMessageOutbox(path)
    assert outbox.enqueue(prepare)
    assert not outbox.enqueue(prepare)
    attempts = outbox.claim_due(prepare['sentAtUptimeMs'])
    assert len(attempts) == 1 and attempts[0].attempt_number == 1
    assert strict_json_loads(attempts[0].canonical_json) == prepare
    assert outbox.claim_due(prepare['sentAtUptimeMs'] + 99) == []
    outbox.close()

    outbox = DurableMessageOutbox(path)
    second = outbox.claim_due(prepare['sentAtUptimeMs'] + 100)
    assert len(second) == 1 and second[0].attempt_number == 2
    assert second[0].canonical_json == attempts[0].canonical_json
    assert outbox.observe_inbound(ready)
    assert outbox.pending() == []
    outbox.integrity_check()

    conflict = deepcopy(prepare)
    conflict['sentAtUptimeMs'] += 1
    with pytest.raises(OutboxConflict, match='different canonical'):
        outbox.enqueue(conflict)
    outbox.close()


def test_durable_outbox_waits_for_all_command_obligations(tmp_path):
    from a620_gate0.durable_outbox import DurableMessageOutbox

    messages = load('valid_complete_flow.json')['messages']
    start = next(m for m in messages if m['messageType'] == 'START')
    accepted = next(m for m in messages if m['messageType'] == 'COMMAND_ACCEPTED')
    started = next(m for m in messages if m['messageType'] == 'STARTED')
    outbox = DurableMessageOutbox(tmp_path / 'outbox.db')
    outbox.enqueue(start)
    assert not outbox.observe_inbound(accepted)
    assert [row['messageType'] for row in outbox.pending()] == ['START']
    assert outbox.observe_inbound(started)
    assert outbox.pending() == []
    outbox.close()


def test_batch_evidence_outbox_released_only_after_result_commit_ack(tmp_path):
    from a620_gate0.durable_outbox import DurableMessageOutbox

    messages = load('valid_complete_flow.json')['messages']
    batches = [m for m in messages if m['messageType'] == 'BATCH_CLOSED']
    result = next(m for m in messages if m['messageType'] == 'RESULT_READY')
    ack = next(m for m in messages if m['messageType'] == 'ACK_RESULT_COMMITTED')
    outbox = DurableMessageOutbox(tmp_path / 'outbox.db')
    for event in batches:
        outbox.enqueue(event)
    outbox.enqueue(result)
    assert len(outbox.pending()) == len(batches) + 1
    assert outbox.observe_inbound(ack)
    assert outbox.pending() == []
    outbox.integrity_check()
    outbox.close()


def test_outbox_cancel_superseded_runtime_stops_all_retries(tmp_path):
    from a620_gate0.durable_outbox import DurableMessageOutbox

    prepare = next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType'] == 'PREPARE')
    outbox = DurableMessageOutbox(tmp_path / 'outbox.db')
    outbox.enqueue(prepare)
    assert outbox.cancel_runtime(prepare['runtimeSessionId'], 'SUPERSEDED_EXECUTION', now_uptime_ms=999) == 1
    assert outbox.claim_due(10_000) == []
    outbox.close()


def test_runtime_watchdog_closes_missing_response_and_heartbeat_paths():
    from a620_gate0.runtime_watchdog import RuntimeWatchdog

    messages = load('valid_complete_flow.json')['messages']
    prepare = next(m for m in messages if m['messageType'] == 'PREPARE')
    ready = next(m for m in messages if m['messageType'] == 'READY')
    start = next(m for m in messages if m['messageType'] == 'START')
    accepted = next(m for m in messages if m['messageType'] == 'COMMAND_ACCEPTED')
    started = next(m for m in messages if m['messageType'] == 'STARTED')
    heartbeat = next(m for m in messages if m['messageType'] == 'HEARTBEAT')

    watchdog = RuntimeWatchdog()
    watchdog.observe_outbound(prepare)
    assert watchdog.poll(prepare['sentAtUptimeMs'] + 9_999) is None
    assert watchdog.poll(prepare['sentAtUptimeMs'] + 10_000).code == 'READY_TIMEOUT'

    watchdog = RuntimeWatchdog()
    watchdog.observe_outbound(prepare)
    watchdog.observe_inbound(ready)
    watchdog.observe_outbound(start)
    watchdog.observe_inbound(accepted)
    watchdog.observe_inbound(started)
    watchdog.observe_inbound(heartbeat)
    assert watchdog.poll(heartbeat['sentAtUptimeMs'] + 3_499) is None
    failure = watchdog.poll(heartbeat['sentAtUptimeMs'] + 3_500)
    assert failure is not None and failure.code == 'HEARTBEAT_TIMEOUT'
    assert failure.action == 'INTERRUPT_EXECUTION_WITHOUT_FORMAL_RESULT'


def test_runtime_watchdog_finalization_and_local_commit_timeouts():
    from a620_gate0.runtime_watchdog import RuntimeWatchdog

    messages = load('valid_complete_flow.json')['messages']
    result = next(m for m in messages if m['messageType'] == 'RESULT_READY')
    ack = next(m for m in messages if m['messageType'] == 'ACK_RESULT_COMMITTED')

    watchdog = RuntimeWatchdog()
    watchdog.enter_state('FINALIZING', 301_000)
    assert watchdog.poll(305_999) is None
    assert watchdog.poll(306_000).code == 'RESULT_READY_TIMEOUT'

    watchdog = RuntimeWatchdog()
    watchdog.enter_state('FINALIZING', 300_000)
    watchdog.observe_inbound(result)
    assert watchdog.poll(result['sentAtUptimeMs'] + 4_999) is None
    watchdog.observe_outbound(ack)
    assert watchdog.poll(result['sentAtUptimeMs'] + 100_000) is None


def test_runtime_watchdog_snapshot_restores_pending_and_terminal_state():
    from a620_gate0.runtime_watchdog import RuntimeWatchdog

    messages = load('valid_complete_flow.json')['messages']
    prepare = next(m for m in messages if m['messageType'] == 'PREPARE')
    watchdog = RuntimeWatchdog()
    watchdog.observe_outbound(prepare)
    restored = RuntimeWatchdog.from_snapshot(watchdog.snapshot())
    assert restored.pending_deadlines() == watchdog.pending_deadlines()
    assert restored.poll(prepare['sentAtUptimeMs'] + 9_999) is None
    failure = restored.poll(prepare['sentAtUptimeMs'] + 10_000)
    assert failure is not None and failure.code == 'READY_TIMEOUT'

    terminal_snapshot = restored.snapshot()
    terminal = RuntimeWatchdog.from_snapshot(terminal_snapshot)
    assert terminal.poll(999_999) == failure

    malformed = deepcopy(terminal_snapshot)
    malformed['deadlines'] = [{
        'key': 'x', 'code': 'Y', 'atUptimeMs': -1, 'relatedMessageId': None
    }]
    with pytest.raises(ValueError, match='malformed|inconsistent'):
        RuntimeWatchdog.from_snapshot(malformed)


def test_runtime_audit_chain_detects_message_and_chain_tampering(tmp_path):
    messages = load('valid_complete_flow.json')['messages']
    prepare = next(m for m in messages if m['messageType'] == 'PREPARE')
    ready = next(m for m in messages if m['messageType'] == 'READY')
    identity = {k: prepare[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','packageVersion','coreProtocolVersion','monotonicEpochId']}
    path = tmp_path / 'journal.db'

    journal = DurableRuntimeJournal(path)
    journal.activate(identity)
    journal.ingest(prepare)
    journal.ingest(ready)
    head = journal.verify_audit_chain()
    assert head['entryCount'] == 2 and len(head['headSha256']) == 64
    journal.db.execute("UPDATE runtime_audit_chain SET entry_sha256=? WHERE journal_index=2", ('0' * 64,))
    with pytest.raises(JournalConflict, match='entry hash'):
        journal.verify_audit_chain()
    journal.close()


def test_runtime_audit_chain_backfills_baseline3_database_once(tmp_path):
    # Build a minimal pre-baseline.4 journal schema with one canonical message.
    import sqlite3
    prepare = next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType'] == 'PREPARE')
    path = tmp_path / 'legacy.db'
    db = sqlite3.connect(path)
    db.executescript('''
      CREATE TABLE active_runtime(singleton INTEGER PRIMARY KEY, identity_json BLOB NOT NULL);
      CREATE TABLE runtime_message_journal(
        message_id TEXT PRIMARY KEY,runtime_session_id TEXT NOT NULL,sender_role TEXT NOT NULL,
        sender_seq INTEGER NOT NULL,sent_at_uptime_ms INTEGER NOT NULL,canonical_sha256 TEXT NOT NULL,
        canonical_json BLOB NOT NULL,disposition TEXT NOT NULL);
      CREATE TABLE sender_cursor(runtime_session_id TEXT,sender_role TEXT,last_sender_seq INTEGER,last_sent_at_uptime_ms INTEGER,PRIMARY KEY(runtime_session_id,sender_role));
      CREATE TABLE reducer_snapshot(runtime_session_id TEXT PRIMARY KEY,snapshot_sha256 TEXT NOT NULL,snapshot_json BLOB NOT NULL);
    ''')
    raw = canonical_bytes(prepare)
    db.execute(
        'INSERT INTO runtime_message_journal VALUES(?,?,?,?,?,?,?,?)',
        (prepare['messageId'], prepare['runtimeSessionId'], prepare['senderRole'], prepare['senderSeq'], prepare['sentAtUptimeMs'], canonical_sha256(prepare), raw, 'NEW'),
    )
    db.commit(); db.close()

    journal = DurableRuntimeJournal(path)
    assert journal.verify_audit_chain()['entryCount'] == 1
    journal.close()


def test_reducer_snapshot_v12_is_compact_and_reads_v11_migration():
    messages = load('valid_complete_flow.json')['messages']
    validator = FlowValidator()
    for message in messages[:5]:
        validator.process(message)
    snapshot = validator.snapshot()
    assert snapshot['snapshotVersion'] == 'A620-RSN-1.2'
    assert 'seenMessageSha256' in snapshot and 'seenMessageCanonicalHex' not in snapshot
    assert FlowValidator.from_snapshot(snapshot).state == validator.state

    legacy = deepcopy(snapshot)
    legacy['snapshotVersion'] = 'A620-RSN-1.1'
    legacy['seenMessageCanonicalHex'] = {
        message['messageId']: canonical_bytes(message).hex() for message in messages[:5]
    }
    legacy.pop('seenMessageSha256')
    migrated = FlowValidator.from_snapshot(legacy)
    assert migrated.state == validator.state
    assert migrated.snapshot()['snapshotVersion'] == 'A620-RSN-1.2'


def test_ipc_frame_deterministic_random_fragmentation_and_coalescing():
    import random
    from a620_gate0.ipc_frame import FrameDecoder, decode_canonical_payload, encode_frame

    rng = random.Random(20260817)
    values = [
        {'i': i, 'text': '捕光' if i % 2 == 0 else '信号', 'items': list(range(i % 11))}
        for i in range(200)
    ]
    wire = b''.join(encode_frame(value) for value in values)
    decoder = FrameDecoder()
    payloads = []
    offset = 0
    while offset < len(wire):
        step = rng.randint(1, 97)
        payloads.extend(decoder.feed(wire[offset:offset + step]))
        offset += step
    decoder.finish()
    assert [decode_canonical_payload(payload) for payload in payloads] == values


def test_runtime_audit_migration_marker_blocks_full_chain_rebackfill(tmp_path):
    messages = load('valid_complete_flow.json')['messages']
    prepare = next(m for m in messages if m['messageType'] == 'PREPARE')
    ready = next(m for m in messages if m['messageType'] == 'READY')
    identity = {k: prepare[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','packageVersion','coreProtocolVersion','monotonicEpochId']}
    path = tmp_path / 'journal.db'

    journal = DurableRuntimeJournal(path)
    journal.activate(identity)
    journal.ingest(prepare)
    journal.ingest(ready)
    assert journal.verify_audit_chain()['entryCount'] == 2
    # Simulate complete chain deletion and anchor reset while the durable
    # baseline.4 migration marker remains. Reopening must fail closed rather
    # than treating the database as baseline.3 again.
    journal.db.execute('DELETE FROM runtime_audit_chain')
    journal.db.execute(
        'UPDATE runtime_audit_anchor SET entry_count=0,head_sha256=? WHERE singleton=1',
        ('0' * 64,),
    )
    journal.close()

    with pytest.raises(JournalConflict, match='disappeared'):
        DurableRuntimeJournal(path)


def test_runtime_audit_anchor_detects_tail_truncation(tmp_path):
    messages = load('valid_complete_flow.json')['messages']
    prepare = next(m for m in messages if m['messageType'] == 'PREPARE')
    ready = next(m for m in messages if m['messageType'] == 'READY')
    identity = {k: prepare[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','packageVersion','coreProtocolVersion','monotonicEpochId']}
    journal = DurableRuntimeJournal(tmp_path / 'journal.db')
    journal.activate(identity)
    journal.ingest(prepare)
    journal.ingest(ready)
    journal.db.execute("DELETE FROM runtime_audit_chain WHERE journal_index=2")
    journal.db.execute("DELETE FROM runtime_message_journal WHERE message_id=?", (ready['messageId'],))
    with pytest.raises(JournalConflict, match='anchor'):
        journal.verify_audit_chain()
    journal.close()


def test_runtime_profile_generated_sources_are_current():
    subprocess.run(
        [sys.executable, str(ROOT / 'python/tools/generate_runtime_profile_sources.py'), '--check'],
        cwd=ROOT,
        check=True,
    )


def test_reducer_snapshot_maximum_message_fingerprint_budget_is_serializable():
    validator = FlowValidator()
    validator.seen_messages = {
        f'msg-{index:04d}': f'{index:064x}'[-64:]
        for index in range(validator.MAX_SEEN_MESSAGES_PER_RUNTIME)
    }
    snapshot = validator.snapshot()
    encoded = canonical_bytes(snapshot)
    assert len(encoded) < 1_000_000
    restored = FlowValidator.from_snapshot(snapshot)
    assert len(restored.seen_messages) == validator.MAX_SEEN_MESSAGES_PER_RUNTIME


def test_outbox_rejects_sender_sequence_reuse_and_prunes_only_terminal_rows(tmp_path):
    from a620_gate0.durable_outbox import DurableMessageOutbox, OutboxConflict

    messages = load('valid_complete_flow.json')['messages']
    prepare = next(m for m in messages if m['messageType'] == 'PREPARE')
    ready = next(m for m in messages if m['messageType'] == 'READY')
    outbox = DurableMessageOutbox(tmp_path / 'outbox.db')
    outbox.enqueue(prepare)
    conflicting = deepcopy(prepare)
    conflicting['messageId'] = 'different-id-same-seq'
    with pytest.raises(OutboxConflict, match='senderSeq'):
        outbox.enqueue(conflicting)
    outbox.observe_inbound(ready, now_uptime_ms=500)
    assert outbox.prune_terminal(before_uptime_ms=500) == 0
    assert outbox.prune_terminal(before_uptime_ms=501) == 1
    outbox.close()


def test_outbox_integrity_rejects_indexed_metadata_tampering(tmp_path):
    from a620_gate0.durable_outbox import DurableMessageOutbox, OutboxConflict

    prepare = next(m for m in load('valid_complete_flow.json')['messages'] if m['messageType'] == 'PREPARE')
    outbox = DurableMessageOutbox(tmp_path / 'outbox.db')
    outbox.enqueue(prepare)
    outbox.db.execute("UPDATE durable_outbox SET message_type='START' WHERE message_id=?", (prepare['messageId'],))
    with pytest.raises(OutboxConflict, match='metadata'):
        outbox.integrity_check()
    outbox.close()
