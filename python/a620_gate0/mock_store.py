from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .canonical import canonical_bytes, canonical_sha256
from .controller_state import build_controller_state_record
from .result_validator import build_execution_outcome, build_formal_result, validate_game_payload


class CommitConflict(ValueError):
    pass


@dataclass(frozen=True)
class CommitAck:
    result_id: str
    result_payload_sha256: str
    committed_at_utc: str
    committed_at_uptime_ms: int
    idempotent_replay: bool


class MockResultStore:
    """SQLite reference for the Android durable boundary.

    Batch evidence is persisted incrementally as batches close. At normal
    completion, immutable formal result, sync-queue row and mutable controller
    state are committed atomically. Interrupted/discarded executions use a
    separate outcome transaction and never create a formal result.
    """

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.db = sqlite3.connect(str(path))
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS batch_evidence (
              runtime_session_id TEXT NOT NULL,
              batch_ordinal INTEGER NOT NULL,
              payload_sha256 TEXT NOT NULL,
              payload_json BLOB NOT NULL,
              PRIMARY KEY(runtime_session_id, batch_ordinal)
            );
            CREATE TABLE IF NOT EXISTS formal_result (
              result_id TEXT PRIMARY KEY,
              runtime_session_id TEXT NOT NULL UNIQUE,
              payload_sha256 TEXT NOT NULL,
              result_json BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS execution_outcome (
              runtime_session_id TEXT PRIMARY KEY,
              completion_state TEXT NOT NULL CHECK(completion_state IN ('INTERRUPTED','DISCARDED')),
              outcome_json BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_queue (
              result_id TEXT PRIMARY KEY REFERENCES formal_result(result_id),
              sync_state TEXT NOT NULL CHECK(sync_state IN ('PENDING_UPLOAD','WAITING_ACK','SYNCED'))
            );
            CREATE TABLE IF NOT EXISTS controller_state (
              runtime_session_id TEXT PRIMARY KEY,
              state_json BLOB NOT NULL
            );
            """
        )

    def record_batch_evidence(self, runtime_session_id: str, batch: dict[str, Any]) -> None:
        ordinal = batch["batchOrdinal"]
        sha = batch["batchPayloadSha256"]
        encoded = canonical_bytes(batch)
        row = self.db.execute(
            "SELECT payload_sha256, payload_json FROM batch_evidence WHERE runtime_session_id=? AND batch_ordinal=?",
            (runtime_session_id, ordinal),
        ).fetchone()
        if row:
            if row[0] != sha or bytes(row[1]) != encoded:
                raise CommitConflict(f"batch evidence conflict at ordinal {ordinal}")
            return

        expected_next = self.db.execute(
            "SELECT COALESCE(MAX(batch_ordinal),0)+1 FROM batch_evidence WHERE runtime_session_id=?",
            (runtime_session_id,),
        ).fetchone()[0]
        if ordinal != expected_next:
            raise CommitConflict(f"batch evidence must be contiguous: expected {expected_next}, got {ordinal}")

        self.db.execute(
            "INSERT INTO batch_evidence(runtime_session_id,batch_ordinal,payload_sha256,payload_json) VALUES(?,?,?,?)",
            (runtime_session_id, ordinal, sha, encoded),
        )
        self.db.commit()

    def _ledger(self, runtime_session_id: str) -> dict[int, str]:
        return {
            int(ordinal): str(payload_hash)
            for ordinal, payload_hash in self.db.execute(
                "SELECT batch_ordinal,payload_sha256 FROM batch_evidence WHERE runtime_session_id=? ORDER BY batch_ordinal",
                (runtime_session_id,),
            )
        }

    def commit_formal_result(
        self,
        *,
        identity: dict[str, Any],
        game_payload: dict[str, Any],
        result_id: str,
        committed_at_utc: str,
        committed_at_uptime_ms: int,
        inject_failure_after_result: bool = False,
    ) -> CommitAck:
        runtime_session_id = identity["runtimeSessionId"]
        if self.db.execute("SELECT 1 FROM execution_outcome WHERE runtime_session_id=?", (runtime_session_id,)).fetchone():
            raise CommitConflict("execution already has an interrupted/discarded outcome")

        ledger = self._ledger(runtime_session_id)
        validate_game_payload(game_payload, evidence_ledger=ledger)
        result = build_formal_result(
            identity=identity,
            payload=game_payload,
            result_id=result_id,
            saved_at_utc=committed_at_utc,
            saved_at_uptime_ms=committed_at_uptime_ms,
        )
        result_bytes = canonical_bytes(result)
        payload_hash = canonical_sha256(game_payload)

        existing = self.db.execute(
            "SELECT result_id,payload_sha256,result_json FROM formal_result WHERE runtime_session_id=? OR result_id=?",
            (runtime_session_id, result_id),
        ).fetchone()
        if existing:
            if existing[0] != result_id or existing[1] != payload_hash or bytes(existing[2]) != result_bytes:
                raise CommitConflict("resultId/runtimeSessionId already committed with different content")
            return CommitAck(result_id, payload_hash, committed_at_utc, committed_at_uptime_ms, True)

        controller_state = build_controller_state_record(
            identity=identity,
            runtime_state="RESULT_COMMITTED",
            completion_state="COMPLETE",
            sync_state="PENDING_UPLOAD",
            task_slot_state="OCCUPIED",
            result_id=result_id,
            updated_at_utc=committed_at_utc,
            updated_at_uptime_ms=committed_at_uptime_ms,
        )

        try:
            self.db.execute("BEGIN IMMEDIATE")
            self.db.execute(
                "INSERT INTO formal_result(result_id,runtime_session_id,payload_sha256,result_json) VALUES(?,?,?,?)",
                (result_id, runtime_session_id, payload_hash, result_bytes),
            )
            if inject_failure_after_result:
                raise RuntimeError("injected failure after formal_result insert")
            self.db.execute(
                "INSERT INTO sync_queue(result_id,sync_state) VALUES(?, 'PENDING_UPLOAD')",
                (result_id,),
            )
            self.db.execute(
                "INSERT INTO controller_state(runtime_session_id,state_json) VALUES(?,?)",
                (runtime_session_id, canonical_bytes(controller_state)),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return CommitAck(result_id, payload_hash, committed_at_utc, committed_at_uptime_ms, False)

    def commit_execution_outcome(
        self,
        *,
        identity: dict[str, Any],
        game_code: str,
        completion_state: str,
        reason_code: str,
        active_elapsed_ms: int,
        recorded_at_utc: str,
        recorded_at_uptime_ms: int,
        audit_snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        runtime_session_id = identity["runtimeSessionId"]
        if self.db.execute("SELECT 1 FROM formal_result WHERE runtime_session_id=?", (runtime_session_id,)).fetchone():
            raise CommitConflict("execution already has a formal result")

        outcome = build_execution_outcome(
            identity=identity,
            game_code=game_code,
            completion_state=completion_state,
            reason_code=reason_code,
            active_elapsed_ms=active_elapsed_ms,
            recorded_at_utc=recorded_at_utc,
            recorded_at_uptime_ms=recorded_at_uptime_ms,
            audit_snapshot=audit_snapshot,
        )
        runtime_state = "ERROR" if completion_state == "INTERRUPTED" else "TERMINATED"
        slot_state = "INTERRUPTED_WAIT" if completion_state == "INTERRUPTED" else "END_RECONCILING"
        controller_state = build_controller_state_record(
            identity=identity,
            runtime_state=runtime_state,
            completion_state=completion_state,
            sync_state=None,
            task_slot_state=slot_state,
            result_id=None,
            updated_at_utc=recorded_at_utc,
            updated_at_uptime_ms=recorded_at_uptime_ms,
        )
        outcome_bytes = canonical_bytes(outcome)

        existing = self.db.execute(
            "SELECT completion_state,outcome_json FROM execution_outcome WHERE runtime_session_id=?",
            (runtime_session_id,),
        ).fetchone()
        if existing:
            if existing[0] != completion_state or bytes(existing[1]) != outcome_bytes:
                raise CommitConflict("execution outcome replay differs from committed content")
            return outcome

        try:
            self.db.execute("BEGIN IMMEDIATE")
            self.db.execute(
                "INSERT INTO execution_outcome(runtime_session_id,completion_state,outcome_json) VALUES(?,?,?)",
                (runtime_session_id, completion_state, outcome_bytes),
            )
            self.db.execute(
                "INSERT INTO controller_state(runtime_session_id,state_json) VALUES(?,?)",
                (runtime_session_id, canonical_bytes(controller_state)),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return outcome

    def counts(self) -> dict[str, int]:
        tables = ("batch_evidence", "formal_result", "execution_outcome", "sync_queue", "controller_state")
        return {table: int(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) for table in tables}
