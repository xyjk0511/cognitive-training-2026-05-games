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
from a620_gate0.flow_validator import validate_flow, ValidationError
from a620_gate0.result_validator import (
    build_formal_result,
    derive_quality_flag,
    validate_formal_result,
    validate_game_payload,
)
from a620_gate0.tpkg import build_tpkg, validate_tpkg, TpkgError
from a620_gate0.mock_store import MockResultStore, CommitConflict
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
    assert validate_tpkg(pkg,next_trust,apk_version='0.1.0',expected_game_code='CATCH_LIGHT')['releaseSequence']==1

    revoked=deepcopy(trust); revoked['keys'][0]['status']='REVOKED'
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

def test_mock_result_store_atomic_commit_and_idempotency():
    obj=load('valid_complete_flow.json')
    messages=obj['messages']
    ready=next(m for m in messages if m['messageType']=='RESULT_READY')
    identity={k:ready[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','monotonicEpochId','packageVersion','coreProtocolVersion']}
    store=MockResultStore()
    for batch in [m['payload'] for m in messages if m['messageType']=='BATCH_CLOSED']:
        store.record_batch_evidence(identity['runtimeSessionId'],batch)
    assert store.counts()=={'batch_evidence':7,'formal_result':0,'sync_queue':0,'execution_outcome':0,'controller_state':0}
    with pytest.raises(RuntimeError):
        store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020,inject_failure_after_result=True)
    assert store.counts()=={'batch_evidence':7,'formal_result':0,'sync_queue':0,'execution_outcome':0,'controller_state':0}
    ack=store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020)
    assert store.counts()=={'batch_evidence':7,'formal_result':1,'sync_queue':1,'execution_outcome':0,'controller_state':1} and not ack.idempotent_replay
    replay=store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:06:00Z',committed_at_uptime_ms=360000)
    assert replay.idempotent_replay
    assert replay.committed_at_utc=='2026-08-17T05:05:01Z' and replay.committed_at_uptime_ms==301020
    assert store.counts()=={'batch_evidence':7,'formal_result':1,'sync_queue':1,'execution_outcome':0,'controller_state':1}

    conflicting_identity=deepcopy(identity); conflicting_identity['taskId']='TASK-OTHER'
    with pytest.raises(CommitConflict):
        store.commit_formal_result(identity=conflicting_identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:06:00Z',committed_at_uptime_ms=360000)


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
    stored=store.commit_execution_outcome(
        identity=identity,game_code='CATCH_LIGHT',completion_state='INTERRUPTED',
        reason_code='A620-RUNTIME-CRASH',active_elapsed_ms=1234,
        recorded_at_utc='2026-08-17T05:00:02Z',recorded_at_uptime_ms=2234,audit_snapshot={},
    )
    assert stored==outcome
    assert store.counts()=={'batch_evidence':0,'formal_result':0,'sync_queue':0,'execution_outcome':1,'controller_state':1}
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
