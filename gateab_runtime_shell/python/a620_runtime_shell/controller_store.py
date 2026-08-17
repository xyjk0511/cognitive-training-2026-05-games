from __future__ import annotations

import dataclasses
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from a620_coordination.runtime_store import RuntimeCoordinationStore
from a620_coordination.sqlite_support import (
    canonical_json_bytes, canonical_sha256, connect, immediate_transaction, load_blob,
)
from .generated_profiles import PROFILES, STORAGE_PROFILE_SHA256

class RuntimeShellError(RuntimeError): pass
class MigrationError(RuntimeShellError): pass
class DurabilityInvariantError(RuntimeShellError): pass
class StoragePressure(RuntimeShellError): pass
class ProtocolConflict(RuntimeShellError): pass

@dataclasses.dataclass(frozen=True)
class BootObservation:
    action: str
    interrupted_runtime_ids: tuple[str, ...]

@dataclasses.dataclass(frozen=True)
class CommitReceipt:
    result_id: str
    result_payload_sha256: str
    committed_at_uptime_ms: int
    ack_message_id: str
    idempotent_replay: bool

MIGRATION_2_SQL = r"""
CREATE TABLE IF NOT EXISTS controller_meta (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    schema_version INTEGER NOT NULL,
    boot_epoch_id TEXT,
    last_uptime_ms INTEGER NOT NULL DEFAULT 0,
    profile_sha256 TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_ledger (
    target_version INTEGER PRIMARY KEY,
    migration_id TEXT NOT NULL UNIQUE,
    migration_sha256 TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
);
ALTER TABLE runtime_session ADD COLUMN finalization_kind TEXT
    CHECK(finalization_kind IS NULL OR finalization_kind IN ('RESULT','OUTCOME'));
ALTER TABLE runtime_session ADD COLUMN identity_json BLOB;
ALTER TABLE runtime_session ADD COLUMN prepare_payload_json BLOB;
ALTER TABLE runtime_session ADD COLUMN game_code TEXT;
ALTER TABLE runtime_session ADD COLUMN planned_batch_count INTEGER;
ALTER TABLE runtime_session ADD COLUMN session_start_level INTEGER;
ALTER TABLE runtime_session ADD COLUMN duration_ms INTEGER;
ALTER TABLE runtime_session ADD COLUMN runtime_config_hash TEXT;
ALTER TABLE outbox_message ADD COLUMN message_type TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE outbox_message ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox_message ADD COLUMN priority TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK(priority IN ('NORMAL','CRITICAL'));
ALTER TABLE execution_outcome ADD COLUMN outcome_json BLOB;
CREATE TABLE IF NOT EXISTS batch_evidence (
    runtime_session_id TEXT NOT NULL REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
    batch_ordinal INTEGER NOT NULL CHECK(batch_ordinal >= 1),
    batch_score INTEGER NOT NULL CHECK(batch_score BETWEEN 0 AND 100),
    payload_sha256 TEXT NOT NULL,
    payload_json BLOB NOT NULL,
    closed_at_active_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(runtime_session_id,batch_ordinal)
);
CREATE TABLE IF NOT EXISTS formal_result (
    result_id TEXT PRIMARY KEY,
    runtime_session_id TEXT NOT NULL UNIQUE REFERENCES runtime_session(runtime_session_id),
    result_payload_sha256 TEXT NOT NULL,
    result_json BLOB NOT NULL,
    committed_at_uptime_ms INTEGER NOT NULL,
    ack_message_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sync_queue (
    result_id TEXT PRIMARY KEY REFERENCES formal_result(result_id) ON DELETE CASCADE,
    sync_state TEXT NOT NULL CHECK(sync_state IN ('PENDING_UPLOAD','WAITING_ACK','SYNCED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS controller_state (
    runtime_session_id TEXT PRIMARY KEY REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
    completion_state TEXT NOT NULL CHECK(completion_state IN ('COMPLETE','INTERRUPTED','DISCARDED')),
    sync_state TEXT CHECK(sync_state IS NULL OR sync_state IN ('PENDING_UPLOAD','WAITING_ACK','SYNCED')),
    task_slot_state TEXT NOT NULL CHECK(task_slot_state IN ('IDLE','OCCUPIED','END_RECONCILING','INTERRUPTED_WAIT')),
    result_id TEXT,
    state_json BLOB NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_event (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    runtime_session_id TEXT,
    event_type TEXT NOT NULL,
    detail_json BLOB NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS batch_evidence_runtime_idx ON batch_evidence(runtime_session_id,batch_ordinal);
CREATE INDEX IF NOT EXISTS formal_result_runtime_idx ON formal_result(runtime_session_id);
UPDATE outbox_message SET payload_bytes=length(canonical_bytes) WHERE payload_bytes=0;
"""
MIGRATION_2_ID = "baseline5-to-gateab-runtime-shell-v2.1"
MIGRATION_2_SEMANTICS = MIGRATION_2_SQL + "\nlegacy-runtime-backfill:MIGRATION_RESTART_REQUIRED:v1\n"
MIGRATION_2_SHA256 = hashlib.sha256(MIGRATION_2_SEMANTICS.encode("utf-8")).hexdigest()

class A620ControllerStore:
    """Executable SQLite reference for the future single Room database.

    It opens an actual baseline.5 coordination database and migrates it to a
    schema that includes formal results, sync queue and result-commit ACKs in
    the same transaction boundary. It is intentionally stricter than a UI
    mock: startup invariant failures stop use of the database.
    """
    def __init__(self, db_path: str | Path, *, boot_epoch_id: str, now_ms: int):
        self.db_path = str(db_path)
        self._ensure_legacy_schema_if_empty()
        self._migrate(now_ms)
        self._integrity_check()
        self.boot_observation = self.observe_boot(boot_epoch_id=boot_epoch_id, now_ms=now_ms)
        self.audit_durability_invariants()

    def _conn(self) -> sqlite3.Connection:
        return connect(self.db_path)

    def _ensure_legacy_schema_if_empty(self) -> None:
        conn = connect(self.db_path)
        try:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            conn.close()
        if not tables:
            RuntimeCoordinationStore(self.db_path)

    def _migrate(self, now_ms: int) -> None:
        conn = self._conn()
        try:
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            required_v1 = {'runtime_session','runtime_snapshot','inbox_message','outbox_message','watchdog_obligation','execution_outcome'}
            if version == 0:
                if not required_v1.issubset(tables):
                    raise MigrationError("unversioned database is not the recognized baseline.5 schema")
                version = 1
                conn.execute("PRAGMA user_version=1")
            if version > 2:
                raise MigrationError(f"database schema {version} is newer than supported schema 2")
            if version == 1:
                with immediate_transaction(conn):
                    for statement in self._split_sql(MIGRATION_2_SQL):
                        conn.execute(statement)
                    self._close_legacy_runtimes_tx(conn, now_ms)
                    conn.execute(
                        "INSERT OR REPLACE INTO migration_ledger(target_version,migration_id,migration_sha256,applied_at_ms) VALUES(2,?,?,?)",
                        (MIGRATION_2_ID, MIGRATION_2_SHA256, now_ms),
                    )
                    conn.execute(
                        "INSERT OR IGNORE INTO controller_meta(singleton_id,schema_version,boot_epoch_id,last_uptime_ms,profile_sha256,updated_at_ms) VALUES(1,2,NULL,0,?,?)",
                        (STORAGE_PROFILE_SHA256, now_ms),
                    )
                    conn.execute("PRAGMA user_version=2")
                version = 2
            if version != 2:
                raise MigrationError("failed to reach schema version 2")
            row = conn.execute("SELECT migration_id,migration_sha256 FROM migration_ledger WHERE target_version=2").fetchone()
            if not row or row['migration_id'] != MIGRATION_2_ID or row['migration_sha256'] != MIGRATION_2_SHA256:
                raise MigrationError("migration ledger checksum mismatch")
            meta = conn.execute("SELECT schema_version,profile_sha256 FROM controller_meta WHERE singleton_id=1").fetchone()
            if not meta or int(meta['schema_version']) != 2:
                raise MigrationError("controller metadata schema version mismatch")
            if meta['profile_sha256'] != STORAGE_PROFILE_SHA256:
                raise MigrationError("runtime-shell normative profile hash differs from database binding")
        finally:
            conn.close()

    def _close_legacy_runtimes_tx(self, conn: sqlite3.Connection, now_ms: int) -> None:
        """Fail closed for baseline.5 runtimes that lack PREPARE identity.

        An app/schema migration must never silently continue a patient session
        whose process and clock ownership predate the new controller schema.
        The product rule is to preserve completed items and redo the current
        unfinished training in a new execution attempt.
        """
        rows = conn.execute(
            "SELECT runtime_session_id,lifecycle,terminal_reason FROM runtime_session "
            "WHERE identity_json IS NULL ORDER BY runtime_session_id"
        ).fetchall()
        for row in rows:
            runtime_id = row["runtime_session_id"]
            if row["lifecycle"] == "ACTIVE":
                self._interrupt_runtime_tx(
                    conn,
                    runtime_id,
                    "MIGRATION_RESTART_REQUIRED",
                    now_ms,
                    "INTERRUPTED",
                )
                continue
            outcome = conn.execute(
                "SELECT completion_state,reason,created_at_ms,outcome_json FROM execution_outcome "
                "WHERE runtime_session_id=?",
                (runtime_id,),
            ).fetchone()
            if not outcome:
                raise MigrationError(
                    f"legacy terminal runtime {runtime_id} has no execution outcome"
                )
            state = outcome["completion_state"]
            reason = outcome["reason"]
            recorded = int(outcome["created_at_ms"])
            if outcome["outcome_json"] is None:
                payload = {
                    "runtimeSessionId": runtime_id,
                    "completionState": state,
                    "reasonCode": reason,
                    "recordedAtUptimeMs": recorded,
                }
                conn.execute(
                    "UPDATE execution_outcome SET outcome_json=? WHERE runtime_session_id=?",
                    (canonical_json_bytes(payload), runtime_id),
                )
            slot = "INTERRUPTED_WAIT" if state == "INTERRUPTED" else "END_RECONCILING"
            controller = {
                "completionState": state,
                "syncState": None,
                "taskSlotState": slot,
                "reasonCode": reason,
            }
            conn.execute(
                "INSERT OR REPLACE INTO controller_state(" 
                "runtime_session_id,completion_state,sync_state,task_slot_state,result_id,state_json,updated_at_ms"
                ") VALUES(?,?,?,?,?,?,?)",
                (runtime_id, state, None, slot, None, canonical_json_bytes(controller), now_ms),
            )
            conn.execute(
                "UPDATE runtime_session SET finalization_kind='OUTCOME',updated_at_ms=? "
                "WHERE runtime_session_id=?",
                (now_ms, runtime_id),
            )
            conn.execute(
                "UPDATE outbox_message SET status='CANCELLED',terminal_note='MIGRATION_RESTART_REQUIRED',"
                "claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=? "
                "WHERE runtime_session_id=? AND status!='ACKED'",
                (now_ms, runtime_id),
            )
            conn.execute(
                "UPDATE watchdog_obligation SET status='CANCELLED',updated_at_ms=? "
                "WHERE runtime_session_id=? AND status='ACTIVE'",
                (now_ms, runtime_id),
            )
            conn.execute("DELETE FROM runtime_lease WHERE runtime_session_id=?", (runtime_id,))

    @staticmethod
    def _split_sql(script: str) -> list[str]:
        statements=[]; buffer=''
        for line in script.splitlines():
            stripped=line.strip()
            if not stripped: continue
            buffer += line + '\n'
            if sqlite3.complete_statement(buffer):
                statements.append(buffer.strip().rstrip(';'))
                buffer=''
        if buffer.strip(): raise MigrationError("incomplete migration SQL")
        return statements

    def _integrity_check(self) -> None:
        conn=self._conn()
        try:
            quick=conn.execute("PRAGMA quick_check").fetchone()[0]
            if quick!='ok': raise DurabilityInvariantError(f"SQLite quick_check failed: {quick}")
            fk=conn.execute("PRAGMA foreign_key_check").fetchall()
            if fk: raise DurabilityInvariantError(f"SQLite foreign_key_check failed: {fk!r}")
        finally: conn.close()

    def observe_boot(self, *, boot_epoch_id: str, now_ms: int) -> BootObservation:
        if not boot_epoch_id or now_ms < 0:
            raise ValueError("invalid boot observation")
        conn=self._conn(); interrupted=[]; action='SAME_BOOT'
        try:
            with immediate_transaction(conn):
                meta=conn.execute("SELECT * FROM controller_meta WHERE singleton_id=1").fetchone()
                if meta['boot_epoch_id'] is None:
                    action='INITIAL_BOOT_BIND'
                elif meta['boot_epoch_id'] != boot_epoch_id:
                    action='BOOT_EPOCH_CHANGED'
                    interrupted=self._interrupt_all_active_tx(conn,'DEVICE_REBOOT',now_ms)
                elif now_ms < int(meta['last_uptime_ms']):
                    action='UPTIME_REGRESSION_FAIL_CLOSED'
                    interrupted=self._interrupt_all_active_tx(conn,'MONOTONIC_CLOCK_REGRESSION',now_ms)
                conn.execute(
                    "UPDATE controller_meta SET boot_epoch_id=?,last_uptime_ms=?,updated_at_ms=? WHERE singleton_id=1",
                    (boot_epoch_id,now_ms,now_ms),
                )
        finally: conn.close()
        return BootObservation(action,tuple(interrupted))

    def _interrupt_all_active_tx(self, conn: sqlite3.Connection, reason: str, now_ms: int) -> list[str]:
        rows=conn.execute("SELECT runtime_session_id FROM runtime_session WHERE lifecycle='ACTIVE' ORDER BY runtime_session_id").fetchall()
        ids=[]
        for row in rows:
            rid=row['runtime_session_id']; ids.append(rid)
            outcome={'runtimeSessionId':rid,'completionState':'INTERRUPTED','reasonCode':reason,'recordedAtUptimeMs':now_ms}
            conn.execute("UPDATE runtime_session SET lifecycle='TERMINAL',terminal_reason=?,finalization_kind='OUTCOME',updated_at_ms=? WHERE runtime_session_id=?",(reason,now_ms,rid))
            conn.execute("INSERT OR REPLACE INTO execution_outcome(runtime_session_id,completion_state,reason,created_at_ms,outcome_json) VALUES(?,?,?,?,?)",(rid,'INTERRUPTED',reason,now_ms,canonical_json_bytes(outcome)))
            state={'completionState':'INTERRUPTED','syncState':None,'taskSlotState':'INTERRUPTED_WAIT','reasonCode':reason}
            conn.execute("INSERT OR REPLACE INTO controller_state VALUES(?,?,?,?,?,?,?)",(rid,'INTERRUPTED',None,'INTERRUPTED_WAIT',None,canonical_json_bytes(state),now_ms))
            conn.execute("UPDATE outbox_message SET status='CANCELLED',terminal_note=?,claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=? WHERE runtime_session_id=? AND status!='ACKED'",(reason,now_ms,rid))
            conn.execute("UPDATE watchdog_obligation SET status='CANCELLED',updated_at_ms=? WHERE runtime_session_id=? AND status='ACTIVE'",(now_ms,rid))
            conn.execute("DELETE FROM runtime_lease WHERE runtime_session_id=?",(rid,))
        return ids

    def register_prepared_runtime(self, *, identity: dict[str,Any], prepare_payload: dict[str,Any], initial_snapshot: dict[str,Any], now_ms: int) -> bool:
        required=('runtimeSessionId','taskItemId','executionAttempt','monotonicEpochId')
        if any(k not in identity for k in required): raise ProtocolConflict("runtime identity incomplete")
        rid=str(identity['runtimeSessionId']); epoch=str(identity['monotonicEpochId'])
        conn=self._conn()
        try:
            with immediate_transaction(conn):
                meta=conn.execute("SELECT boot_epoch_id,last_uptime_ms FROM controller_meta WHERE singleton_id=1").fetchone()
                if epoch != meta['boot_epoch_id']: raise ProtocolConflict("runtime monotonic epoch differs from active boot epoch")
                if now_ms < int(meta['last_uptime_ms']): raise ProtocolConflict("runtime registration uptime regressed")
                existing=conn.execute("SELECT identity_json,prepare_payload_json FROM runtime_session WHERE runtime_session_id=?",(rid,)).fetchone()
                ib=canonical_json_bytes(identity); pb=canonical_json_bytes(prepare_payload); sb=canonical_json_bytes(initial_snapshot)
                if existing:
                    if bytes(existing['identity_json'] or b'')!=ib or bytes(existing['prepare_payload_json'] or b'')!=pb:
                        raise ProtocolConflict("runtime replay differs from original PREPARE")
                    return False
                max_attempt=conn.execute("SELECT MAX(execution_attempt) FROM runtime_session WHERE task_item_id=?",(identity['taskItemId'],)).fetchone()[0]
                if max_attempt is not None and int(identity['executionAttempt'])<=int(max_attempt): raise ProtocolConflict("executionAttempt must increase")
                old=conn.execute("SELECT runtime_session_id FROM runtime_session WHERE task_item_id=? AND lifecycle='ACTIVE'",(identity['taskItemId'],)).fetchall()
                for r in old: self._interrupt_runtime_tx(conn,r['runtime_session_id'],'EXECUTION_SUPERSEDED_BY_NEW_ATTEMPT',now_ms)
                conn.execute("""
                    INSERT INTO runtime_session(
                      runtime_session_id,task_item_id,execution_attempt,monotonic_epoch_id,lifecycle,terminal_reason,state_revision,created_at_ms,updated_at_ms,
                      finalization_kind,identity_json,prepare_payload_json,game_code,planned_batch_count,session_start_level,duration_ms,runtime_config_hash
                    ) VALUES(?,?,?,?, 'ACTIVE',NULL,0,?,?,NULL,?,?,?,?,?,?,?)
                """,(rid,identity['taskItemId'],identity['executionAttempt'],epoch,now_ms,now_ms,ib,pb,prepare_payload.get('gameCode'),prepare_payload.get('plannedBatchCount'),prepare_payload.get('sessionStartLevel'),prepare_payload.get('durationMs'),prepare_payload.get('runtimeConfigHash')))
                conn.execute("INSERT INTO runtime_snapshot(runtime_session_id,revision,snapshot_json,snapshot_sha256,updated_at_ms) VALUES(?,?,?,?,?)",(rid,0,sb,canonical_sha256(initial_snapshot),now_ms))
                conn.execute("UPDATE controller_meta SET last_uptime_ms=?,updated_at_ms=? WHERE singleton_id=1",(now_ms,now_ms))
                return True
        finally: conn.close()

    def append_batch_evidence(self, *, runtime_session_id: str, batch_payload: dict[str,Any], closed_at_active_ms: int, now_ms: int) -> bool:
        ordinal=int(batch_payload['batchOrdinal']); score=int(batch_payload['batchScore']); digest=canonical_sha256({k:v for k,v in batch_payload.items() if k!='batchPayloadSha256'})
        supplied=batch_payload.get('batchPayloadSha256')
        if supplied is not None and supplied!=digest: raise ProtocolConflict("batch payload hash mismatch")
        canonical_payload=dict(batch_payload); canonical_payload['batchPayloadSha256']=digest; blob=canonical_json_bytes(canonical_payload)
        conn=self._conn()
        try:
            with immediate_transaction(conn):
                runtime=self._active_runtime(conn,runtime_session_id)
                existing=conn.execute("SELECT payload_sha256,payload_json FROM batch_evidence WHERE runtime_session_id=? AND batch_ordinal=?",(runtime_session_id,ordinal)).fetchone()
                if existing:
                    if existing['payload_sha256']!=digest or bytes(existing['payload_json'])!=blob: raise ProtocolConflict("batch ordinal replay differs")
                    return False
                previous=conn.execute("SELECT COALESCE(MAX(batch_ordinal),0),COALESCE(MAX(closed_at_active_ms),-1) FROM batch_evidence WHERE runtime_session_id=?",(runtime_session_id,)).fetchone()
                if ordinal!=int(previous[0])+1: raise ProtocolConflict("batch evidence must be contiguous")
                if closed_at_active_ms<=int(previous[1]): raise ProtocolConflict("batch close time must increase")
                planned=runtime['planned_batch_count']
                if planned is not None and ordinal>int(planned): raise ProtocolConflict("batch ordinal exceeds plannedBatchCount")
                conn.execute("INSERT INTO batch_evidence VALUES(?,?,?,?,?,?,?)",(runtime_session_id,ordinal,score,digest,blob,closed_at_active_ms,now_ms))
                return True
        finally: conn.close()

    def enqueue_durable_message(self, *, runtime_session_id: str, message_id: str, message_type: str, message: dict[str,Any], required_acks: Iterable[str], next_attempt_ms: int, now_ms: int) -> bool:
        payload=canonical_json_bytes(message); digest=hashlib.sha256(payload).hexdigest(); priority=self._priority(message_type)
        conn=self._conn()
        try:
            with immediate_transaction(conn):
                self._active_runtime(conn,runtime_session_id)
                return self._enqueue_outbox_tx(conn,runtime_session_id,message_id,message_type,payload,digest,tuple(sorted(set(required_acks))),priority,next_attempt_ms,now_ms)
        finally: conn.close()

    def _priority(self,message_type:str)->str:
        ob=PROFILES['durable_storage.json']['outbox']
        if message_type in ob['nonDurableTypes']: raise ProtocolConflict(f"{message_type} must not enter durable outbox")
        return 'CRITICAL' if message_type in ob['criticalTypes'] else 'NORMAL'

    def _check_quota_tx(self,conn:sqlite3.Connection,rid:str,priority:str,new_bytes:int)->None:
        ob=PROFILES['durable_storage.json']['outbox']
        r=conn.execute("SELECT COUNT(*),COALESCE(SUM(payload_bytes),0) FROM outbox_message WHERE runtime_session_id=? AND status IN ('PENDING','IN_FLIGHT')",(rid,)).fetchone()
        normal=conn.execute("SELECT COUNT(*),COALESCE(SUM(payload_bytes),0) FROM outbox_message WHERE runtime_session_id=? AND priority='NORMAL' AND status IN ('PENDING','IN_FLIGHT')",(rid,)).fetchone()
        g=conn.execute("SELECT COUNT(*),COALESCE(SUM(payload_bytes),0) FROM outbox_message WHERE priority='NORMAL' AND status IN ('PENDING','IN_FLIGHT')").fetchone()
        if priority=='NORMAL':
            if int(normal[0])+1>ob['maxNormalMessagesPerRuntime'] or int(normal[1])+new_bytes>ob['maxNormalBytesPerRuntime'] or int(g[0])+1>ob['maxNormalMessagesGlobal'] or int(g[1])+new_bytes>ob['maxNormalBytesGlobal']:
                raise StoragePressure('normal durable outbox quota exceeded')
        else:
            if int(r[0])+1>ob['maxNormalMessagesPerRuntime']+ob['criticalReserveMessagesPerRuntime'] or int(r[1])+new_bytes>ob['maxNormalBytesPerRuntime']+ob['criticalReserveBytesPerRuntime']:
                raise StoragePressure('critical durable outbox reserve exhausted')

    def _enqueue_outbox_tx(self,conn,rid,message_id,message_type,payload,digest,required,priority,next_attempt_ms,now_ms)->bool:
        existing=conn.execute("SELECT canonical_sha256,message_type FROM outbox_message WHERE message_id=?",(message_id,)).fetchone()
        if existing:
            if existing['canonical_sha256']!=digest or existing['message_type']!=message_type: raise ProtocolConflict('messageId reused with different outbox content')
            return False
        self._check_quota_tx(conn,rid,priority,len(payload))
        conn.execute("""
          INSERT INTO outbox_message(message_id,runtime_session_id,canonical_bytes,canonical_sha256,required_acks_json,received_acks_json,status,next_attempt_ms,attempt_count,claim_owner,claim_generation,claim_until_ms,terminal_note,created_at_ms,updated_at_ms,message_type,payload_bytes,priority)
          VALUES(?,?,?,?,?,?,'PENDING',?,0,NULL,0,NULL,NULL,?,?,?,?,?)
        """,(message_id,rid,payload,digest,canonical_json_bytes(list(required)),canonical_json_bytes([]),next_attempt_ms,now_ms,now_ms,message_type,len(payload),priority))
        return True

    def commit_formal_result(self, *, runtime_session_id: str, result_id: str, result_payload: dict[str,Any], result_ready_message_id: str, ack_message_id: str, committed_at_uptime_ms: int, fault_at: str|None=None) -> CommitReceipt:
        payload_hash=canonical_sha256(result_payload); result_blob=canonical_json_bytes(result_payload)
        conn=self._conn()
        try:
            with immediate_transaction(conn):
                runtime=conn.execute("SELECT * FROM runtime_session WHERE runtime_session_id=?",(runtime_session_id,)).fetchone()
                if not runtime: raise ProtocolConflict('unknown runtime')
                existing=conn.execute("SELECT * FROM formal_result WHERE runtime_session_id=? OR result_id=?",(runtime_session_id,result_id)).fetchone()
                if existing:
                    if existing['result_id']!=result_id or existing['result_payload_sha256']!=payload_hash or bytes(existing['result_json'])!=result_blob or existing['ack_message_id']!=ack_message_id: raise ProtocolConflict('formal result replay differs')
                    return CommitReceipt(result_id,payload_hash,int(existing['committed_at_uptime_ms']),ack_message_id,True)
                if runtime['lifecycle']!='ACTIVE' or runtime['finalization_kind'] is not None: raise ProtocolConflict('runtime is not eligible for formal result')
                if conn.execute("SELECT 1 FROM execution_outcome WHERE runtime_session_id=?",(runtime_session_id,)).fetchone(): raise ProtocolConflict('runtime already has execution outcome')
                self._reconcile_batches_tx(conn,runtime,result_payload)
                conn.execute("INSERT INTO formal_result VALUES(?,?,?,?,?,?)",(result_id,runtime_session_id,payload_hash,result_blob,committed_at_uptime_ms,ack_message_id))
                if fault_at=='after_formal_result': raise RuntimeError(fault_at)
                conn.execute("INSERT INTO sync_queue(result_id,sync_state,attempt_count,next_attempt_ms,last_error) VALUES(?,'PENDING_UPLOAD',0,?,NULL)",(result_id,committed_at_uptime_ms))
                if fault_at=='after_sync_queue': raise RuntimeError(fault_at)
                state={'completionState':'COMPLETE','syncState':'PENDING_UPLOAD','taskSlotState':'OCCUPIED','resultId':result_id,'updatedAtUptimeMs':committed_at_uptime_ms}
                conn.execute("INSERT INTO controller_state VALUES(?,?,?,?,?,?,?)",(runtime_session_id,'COMPLETE','PENDING_UPLOAD','OCCUPIED',result_id,canonical_json_bytes(state),committed_at_uptime_ms))
                if fault_at=='after_controller_state': raise RuntimeError(fault_at)
                ack={'messageType':'ACK_RESULT_COMMITTED','correlationId':result_ready_message_id,'payload':{'resultId':result_id,'resultPayloadSha256':payload_hash,'committedAtUptimeMs':committed_at_uptime_ms}}
                ab=canonical_json_bytes(ack); ad=hashlib.sha256(ab).hexdigest()
                self._enqueue_outbox_tx(conn,runtime_session_id,ack_message_id,'ACK_RESULT_COMMITTED',ab,ad,(), 'CRITICAL',committed_at_uptime_ms,committed_at_uptime_ms)
                if fault_at=='after_ack_outbox': raise RuntimeError(fault_at)
                conn.execute("UPDATE outbox_message SET status='CANCELLED',terminal_note='RESULT_COMMITTED',claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=? WHERE runtime_session_id=? AND message_id<>? AND status!='ACKED'",(committed_at_uptime_ms,runtime_session_id,ack_message_id))
                conn.execute("UPDATE watchdog_obligation SET status='CANCELLED',updated_at_ms=? WHERE runtime_session_id=? AND status='ACTIVE'",(committed_at_uptime_ms,runtime_session_id))
                conn.execute("DELETE FROM runtime_lease WHERE runtime_session_id=?",(runtime_session_id,))
                if fault_at=='before_runtime_finalization': raise RuntimeError(fault_at)
                conn.execute("UPDATE runtime_session SET lifecycle='TERMINAL',terminal_reason='RESULT_COMMITTED',finalization_kind='RESULT',updated_at_ms=? WHERE runtime_session_id=?",(committed_at_uptime_ms,runtime_session_id))
                return CommitReceipt(result_id,payload_hash,committed_at_uptime_ms,ack_message_id,False)
        finally: conn.close()

    def _reconcile_batches_tx(self,conn,runtime,result_payload):
        batches=result_payload.get('eligibleBatches')
        if not isinstance(batches,list): raise ProtocolConflict('eligibleBatches must be an array')
        ledger=conn.execute("SELECT * FROM batch_evidence WHERE runtime_session_id=? ORDER BY batch_ordinal",(runtime['runtime_session_id'],)).fetchall()
        if len(batches)!=len(ledger): raise ProtocolConflict('eligible batch count differs from evidence ledger')
        score=0
        for expected,actual in zip(ledger,batches):
            if int(actual.get('batchOrdinal',-1))!=int(expected['batch_ordinal']): raise ProtocolConflict('batch ordinal differs from evidence ledger')
            if actual.get('batchPayloadSha256')!=expected['payload_sha256']: raise ProtocolConflict('batch hash differs from evidence ledger')
            if int(actual.get('batchScore',-1))!=int(expected['batch_score']): raise ProtocolConflict('batch score differs from evidence ledger')
            score+=int(expected['batch_score'])
        if int(result_payload.get('sessionRawScore',-1))!=score: raise ProtocolConflict('sessionRawScore differs from evidence sum')
        planned=runtime['planned_batch_count']
        if planned is not None and len(batches)>int(planned): raise ProtocolConflict('eligible batches exceed plannedBatchCount')

    def commit_execution_outcome(self, *, runtime_session_id:str, completion_state:str, reason:str, now_ms:int)->bool:
        if completion_state not in {'INTERRUPTED','DISCARDED'}: raise ProtocolConflict('invalid outcome state')
        conn=self._conn()
        try:
            with immediate_transaction(conn):
                runtime=conn.execute("SELECT * FROM runtime_session WHERE runtime_session_id=?",(runtime_session_id,)).fetchone()
                if not runtime: raise ProtocolConflict('unknown runtime')
                existing=conn.execute("SELECT completion_state,reason FROM execution_outcome WHERE runtime_session_id=?",(runtime_session_id,)).fetchone()
                if existing:
                    if (existing['completion_state'],existing['reason'])!=(completion_state,reason): raise ProtocolConflict('outcome replay differs')
                    return False
                if conn.execute("SELECT 1 FROM formal_result WHERE runtime_session_id=?",(runtime_session_id,)).fetchone(): raise ProtocolConflict('runtime already has formal result')
                self._interrupt_runtime_tx(conn,runtime_session_id,reason,now_ms,completion_state)
                return True
        finally: conn.close()

    def _interrupt_runtime_tx(self,conn,rid,reason,now_ms,state='INTERRUPTED'):
        runtime=conn.execute("SELECT * FROM runtime_session WHERE runtime_session_id=?",(rid,)).fetchone()
        if not runtime: raise ProtocolConflict('unknown runtime')
        if runtime['lifecycle']=='TERMINAL': return
        outcome={'runtimeSessionId':rid,'completionState':state,'reasonCode':reason,'recordedAtUptimeMs':now_ms}
        conn.execute("UPDATE runtime_session SET lifecycle='TERMINAL',terminal_reason=?,finalization_kind='OUTCOME',updated_at_ms=? WHERE runtime_session_id=?",(reason,now_ms,rid))
        conn.execute("INSERT INTO execution_outcome(runtime_session_id,completion_state,reason,created_at_ms,outcome_json) VALUES(?,?,?,?,?)",(rid,state,reason,now_ms,canonical_json_bytes(outcome)))
        slot='INTERRUPTED_WAIT' if state=='INTERRUPTED' else 'END_RECONCILING'
        cs={'completionState':state,'syncState':None,'taskSlotState':slot,'reasonCode':reason}
        conn.execute("INSERT INTO controller_state VALUES(?,?,?,?,?,?,?)",(rid,state,None,slot,None,canonical_json_bytes(cs),now_ms))
        conn.execute("UPDATE outbox_message SET status='CANCELLED',terminal_note=?,claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=? WHERE runtime_session_id=? AND status!='ACKED'",(reason,now_ms,rid))
        conn.execute("UPDATE watchdog_obligation SET status='CANCELLED',updated_at_ms=? WHERE runtime_session_id=? AND status='ACTIVE'",(now_ms,rid))
        conn.execute("DELETE FROM runtime_lease WHERE runtime_session_id=?",(rid,))

    def audit_durability_invariants(self)->None:
        conn=self._conn(); errors=[]
        try:
            for r in conn.execute("SELECT * FROM runtime_session ORDER BY runtime_session_id"):
                rid=r['runtime_session_id']; fr=conn.execute("SELECT * FROM formal_result WHERE runtime_session_id=?",(rid,)).fetchone(); eo=conn.execute("SELECT * FROM execution_outcome WHERE runtime_session_id=?",(rid,)).fetchone(); cs=conn.execute("SELECT * FROM controller_state WHERE runtime_session_id=?",(rid,)).fetchone()
                if r['lifecycle']=='ACTIVE':
                    if fr or eo or r['finalization_kind'] is not None: errors.append(f'{rid}: ACTIVE runtime has final record')
                elif r['finalization_kind']=='RESULT':
                    if not fr: errors.append(f'{rid}: RESULT finalization lacks formal_result')
                    else:
                        if not conn.execute("SELECT 1 FROM sync_queue WHERE result_id=?",(fr['result_id'],)).fetchone(): errors.append(f'{rid}: formal result lacks sync_queue')
                        if not conn.execute("SELECT 1 FROM outbox_message WHERE message_id=? AND message_type='ACK_RESULT_COMMITTED'",(fr['ack_message_id'],)).fetchone(): errors.append(f'{rid}: formal result lacks commit ACK outbox')
                    if eo: errors.append(f'{rid}: RESULT finalization also has outcome')
                    if not cs or cs['completion_state']!='COMPLETE': errors.append(f'{rid}: RESULT finalization lacks COMPLETE controller state')
                elif r['finalization_kind']=='OUTCOME':
                    if not eo: errors.append(f'{rid}: OUTCOME finalization lacks execution_outcome')
                    if fr: errors.append(f'{rid}: OUTCOME finalization also has formal_result')
                    if not cs or cs['completion_state'] not in ('INTERRUPTED','DISCARDED'): errors.append(f'{rid}: OUTCOME controller state invalid')
                else: errors.append(f'{rid}: TERMINAL runtime lacks finalization_kind')
            orphan=conn.execute("SELECT o.message_id FROM outbox_message o LEFT JOIN runtime_session r ON r.runtime_session_id=o.runtime_session_id WHERE r.runtime_session_id IS NULL").fetchall()
            if orphan: errors.append('orphan outbox rows exist')
        finally: conn.close()
        if errors: raise DurabilityInvariantError('; '.join(errors))

    def _active_runtime(self,conn,rid):
        row=conn.execute("SELECT * FROM runtime_session WHERE runtime_session_id=?",(rid,)).fetchone()
        if not row: raise ProtocolConflict('unknown runtime')
        if row['lifecycle']!='ACTIVE': raise ProtocolConflict('runtime is terminal')
        return row

    def counts(self)->dict[str,int]:
        tables=('runtime_session','batch_evidence','formal_result','execution_outcome','sync_queue','controller_state','outbox_message','watchdog_obligation')
        conn=self._conn()
        try: return {t:int(conn.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]) for t in tables}
        finally: conn.close()
