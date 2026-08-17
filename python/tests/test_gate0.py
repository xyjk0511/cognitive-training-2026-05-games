from __future__ import annotations
import json
import subprocess
import sys
import zipfile
from copy import deepcopy
from pathlib import Path
import pytest
from a620_gate0.canonical import canonical_bytes, canonical_sha256, CanonicalJsonError
from a620_gate0.flow_validator import validate_flow, ValidationError
from a620_gate0.result_validator import validate_game_payload, derive_quality_flag
from a620_gate0.tpkg import build_tpkg, validate_tpkg, TpkgError
from a620_gate0.mock_store import MockResultStore, CommitConflict
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

@pytest.mark.parametrize('name', ['valid_complete_flow.json','valid_pause_complete_flow.json','valid_terminated_flow.json','valid_same_time_terminate_flow.json','valid_error_flow.json'])
def test_valid_flows(name):
    obj=load(name); validate_flow(obj['messages'],obj['expectedOutcome'])

@pytest.mark.parametrize('name', ['invalid_missing_start_accepted.json','invalid_ready_hash.json','invalid_started_cutoff.json','invalid_result_from_running.json','invalid_batch_evidence_replaced.json','invalid_ack_hash.json','invalid_sender_time_backwards.json','invalid_heartbeat_state.json','invalid_query_without_snapshot.json'])
def test_invalid_flows(name):
    obj=load(name)
    with pytest.raises(Exception): validate_flow(obj['messages'],'COMPLETE')

def test_quality_derivation():
    assert derive_quality_flag(8,8)=='COMPLETE_BATCH_SET'
    assert derive_quality_flag(7,8)=='PARTIAL_ELIGIBLE_BATCHES'
    assert derive_quality_flag(0,8)=='NO_ELIGIBLE_BATCH'

def test_tpkg_roundtrip_and_attacks(tmp_path):
    src=tmp_path/'src'; (src/'bundle').mkdir(parents=True); (src/'bundle/index.json').write_text('{"ok":true}\n',encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    private='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    trust={'TEST-RFC8032-1':'d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'}
    pkg=tmp_path/'ok.tpkg'; build_tpkg(src,pkg,manifest,private)
    valid=validate_tpkg(pkg,trust); assert valid['gameCode']=='CATCH_LIGHT'

    # Duplicate entry attack.
    dup=tmp_path/'dup.tpkg'
    with zipfile.ZipFile(pkg) as zsrc, zipfile.ZipFile(dup,'w') as zout:
        for info in zsrc.infolist(): zout.writestr(info,zsrc.read(info.filename))
        zout.writestr('bundle/index.json',b'evil')
    with pytest.raises(TpkgError): validate_tpkg(dup,trust)

    # Path traversal attack.
    trav=tmp_path/'trav.tpkg'
    with zipfile.ZipFile(pkg) as zsrc, zipfile.ZipFile(trav,'w') as zout:
        for info in zsrc.infolist(): zout.writestr(info,zsrc.read(info.filename))
        zout.writestr('../evil.txt',b'x')
    with pytest.raises(TpkgError): validate_tpkg(trav,trust)


def test_all_schemas_are_valid_draft_2020_12():
    for path in (ROOT/'contracts/schemas').glob('*.json'):
        Draft202012Validator.check_schema(json.loads(path.read_text(encoding='utf-8')))
    for path in (ROOT/'games').glob('*/schemas/*.json'):
        Draft202012Validator.check_schema(json.loads(path.read_text(encoding='utf-8')))

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
    identity={k:ready[k] for k in ['systemId','deviceId','taskId','taskItemId','executionAttempt','runtimeSessionId','packageVersion','coreProtocolVersion']}
    store=MockResultStore()
    for batch in [m['payload'] for m in messages if m['messageType']=='BATCH_CLOSED']:
        store.record_batch_evidence(identity['runtimeSessionId'],batch)
    assert store.counts()==(7,0,0)
    with pytest.raises(RuntimeError):
        store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020,inject_failure_after_result=True)
    assert store.counts()==(7,0,0)
    ack=store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020)
    assert store.counts()==(7,1,1) and not ack.idempotent_replay
    replay=store.commit_formal_result(identity=identity,game_payload=ready['payload']['gamePayload'],result_id='RES-TXN',committed_at_utc='2026-08-17T05:05:01Z',committed_at_uptime_ms=301020)
    assert replay.idempotent_replay and store.counts()==(7,1,1)


def test_manifest_rejects_invalid_version_range(tmp_path):
    src=tmp_path/'src'; (src/'bundle').mkdir(parents=True); (src/'bundle/index.json').write_text('{}',encoding='utf-8')
    manifest=json.loads((ROOT/'packages/catch-light/manifest.base.json').read_text(encoding='utf-8'))
    manifest['minApkVersionInclusive']='1.0.0'; manifest['maxApkVersionExclusive']='1.0.0'
    private='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    trust={'TEST-RFC8032-1':'d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'}
    pkg=tmp_path/'bad-range.tpkg'; build_tpkg(src,pkg,manifest,private)
    with pytest.raises(TpkgError): validate_tpkg(pkg,trust)
