from __future__ import annotations
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from .canonical import canonical_bytes, canonical_sha256
from .result_validator import build_formal_result, validate_game_payload

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
    """SQLite reference for the Android local transaction boundary.

    Formal result, evidence rows and sync queue are written in one transaction.
    This is a reference model, not the final Room implementation.
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
            CREATE TABLE IF NOT EXISTS sync_queue (
              result_id TEXT PRIMARY KEY REFERENCES formal_result(result_id),
              sync_state TEXT NOT NULL CHECK(sync_state IN ('PENDING_UPLOAD','WAITING_ACK','SYNCED'))
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
        self.db.execute(
            "INSERT INTO batch_evidence(runtime_session_id,batch_ordinal,payload_sha256,payload_json) VALUES(?,?,?,?)",
            (runtime_session_id, ordinal, sha, encoded),
        )
        self.db.commit()

    def _ledger(self, runtime_session_id: str) -> dict[int, str]:
        return {int(o): str(h) for o, h in self.db.execute(
            "SELECT batch_ordinal,payload_sha256 FROM batch_evidence WHERE runtime_session_id=? ORDER BY batch_ordinal",
            (runtime_session_id,),
        )}

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
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return CommitAck(result_id, payload_hash, committed_at_utc, committed_at_uptime_ms, False)

    def counts(self) -> tuple[int, int, int]:
        return tuple(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in ("batch_evidence","formal_result","sync_queue"))
