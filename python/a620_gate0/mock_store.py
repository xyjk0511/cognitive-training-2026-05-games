from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .canonical import canonical_bytes, canonical_sha256, strict_json_loads
from .controller_state import build_controller_state_record
from .game_schema import GameSchemaError, validate_game_config
from .result_validator import build_execution_outcome, build_formal_result, validate_game_payload
from .schema import validate_schema


class CommitConflict(ValueError):
    pass


IDENTITY_FIELDS = (
    "systemId",
    "deviceId",
    "taskId",
    "taskItemId",
    "executionAttempt",
    "runtimeSessionId",
    "monotonicEpochId",
    "packageVersion",
    "coreProtocolVersion",
)


@dataclass(frozen=True)
class CommitAck:
    result_id: str
    result_payload_sha256: str
    committed_at_utc: str
    committed_at_uptime_ms: int
    idempotent_replay: bool


def _identity_from_message(message: dict[str, Any]) -> dict[str, Any]:
    return {field: message[field] for field in IDENTITY_FIELDS}


class MockResultStore:
    """SQLite reference for the Android durable boundary.

    This baseline persists the PREPARE contract before accepting batch
    evidence. Final result validation is therefore independent of the live
    Cocos process and survives controller restart. All formal-result/outcome
    decisions begin with ``BEGIN IMMEDIATE`` so two controller workers cannot
    both win a check-then-insert race.
    """

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self.db = sqlite3.connect(self.path, isolation_level=None, timeout=5.0)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=5000")
        if self.path != ":memory:":
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS runtime_session (
              runtime_session_id TEXT PRIMARY KEY,
              system_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              task_id TEXT NOT NULL,
              task_item_id TEXT NOT NULL,
              execution_attempt INTEGER NOT NULL,
              monotonic_epoch_id TEXT NOT NULL,
              package_version TEXT NOT NULL,
              core_protocol_version TEXT NOT NULL,
              identity_json BLOB NOT NULL,
              prepare_message_id TEXT NOT NULL UNIQUE,
              prepare_payload_json BLOB NOT NULL,
              game_code TEXT NOT NULL,
              runtime_config_hash TEXT NOT NULL,
              planned_batch_count INTEGER NOT NULL CHECK(planned_batch_count BETWEEN 1 AND 1024),
              design_max_level INTEGER NOT NULL CHECK(design_max_level BETWEEN 1 AND 10000),
              session_start_level INTEGER NOT NULL,
              duration_ms INTEGER NOT NULL CHECK(duration_ms = 300000),
              session_seed INTEGER NOT NULL,
              generator_version TEXT NOT NULL,
              game_config_schema_id TEXT NOT NULL,
              registered_at_uptime_ms INTEGER NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('ACTIVE','RESULT_COMMITTED','OUTCOME_COMMITTED')),
              UNIQUE(system_id, device_id, task_id, task_item_id, execution_attempt)
            );
            CREATE TABLE IF NOT EXISTS batch_evidence (
              runtime_session_id TEXT NOT NULL REFERENCES runtime_session(runtime_session_id),
              batch_ordinal INTEGER NOT NULL,
              message_id TEXT NOT NULL,
              sender_seq INTEGER NOT NULL,
              received_at_uptime_ms INTEGER NOT NULL,
              closed_at_active_ms INTEGER NOT NULL,
              payload_sha256 TEXT NOT NULL,
              payload_json BLOB NOT NULL,
              PRIMARY KEY(runtime_session_id, batch_ordinal),
              UNIQUE(runtime_session_id, message_id),
              UNIQUE(runtime_session_id, sender_seq)
            );
            CREATE TABLE IF NOT EXISTS formal_result (
              result_id TEXT PRIMARY KEY,
              runtime_session_id TEXT NOT NULL UNIQUE REFERENCES runtime_session(runtime_session_id),
              payload_sha256 TEXT NOT NULL,
              result_json BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS execution_outcome (
              runtime_session_id TEXT PRIMARY KEY REFERENCES runtime_session(runtime_session_id),
              completion_state TEXT NOT NULL CHECK(completion_state IN ('INTERRUPTED','DISCARDED')),
              outcome_json BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_queue (
              result_id TEXT PRIMARY KEY REFERENCES formal_result(result_id),
              sync_state TEXT NOT NULL CHECK(sync_state IN ('PENDING_UPLOAD','WAITING_ACK','SYNCED'))
            );
            CREATE TABLE IF NOT EXISTS controller_state (
              runtime_session_id TEXT PRIMARY KEY REFERENCES runtime_session(runtime_session_id),
              state_json BLOB NOT NULL
            );
            """
        )

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "MockResultStore":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    @staticmethod
    def _validate_prepare(message: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        validate_schema(message, "a620_training_runtime_message.schema.json")
        if message["messageType"] != "PREPARE" or message["senderRole"] != "ANDROID_CONTROLLER":
            raise CommitConflict("runtime session registration requires an Android PREPARE message")
        if message["correlationId"] is not None:
            raise CommitConflict("PREPARE correlationId must be null")
        payload = message["payload"]
        if not 1 <= payload["sessionStartLevel"] <= payload["designMaxLevel"] <= 10000:
            raise CommitConflict("PREPARE level bounds are invalid")
        if not 1 <= payload["plannedBatchCount"] <= 1024:
            raise CommitConflict("PREPARE plannedBatchCount is invalid")
        projection = deepcopy(payload)
        supplied = projection.pop("runtimeConfigHash")
        if supplied != canonical_sha256(projection):
            raise CommitConflict("PREPARE runtimeConfigHash is not self-consistent")
        try:
            validate_game_config(payload["gameCode"], payload["gameConfigSchemaId"], payload["gameConfig"])
        except GameSchemaError as exc:
            raise CommitConflict(str(exc)) from exc
        return _identity_from_message(message), payload

    def register_runtime_session(
        self,
        prepare_message: dict[str, Any],
        *,
        received_at_uptime_ms: int | None = None,
    ) -> bool:
        identity, payload = self._validate_prepare(prepare_message)
        received = prepare_message["sentAtUptimeMs"] if received_at_uptime_ms is None else received_at_uptime_ms
        if not prepare_message["sentAtUptimeMs"] <= received <= 9_007_199_254_740_991:
            raise CommitConflict("PREPARE receive time is outside the valid clock range")
        identity_bytes = canonical_bytes(identity)
        payload_bytes = canonical_bytes(payload)
        runtime_session_id = identity["runtimeSessionId"]

        with self._transaction():
            existing = self.db.execute(
                "SELECT identity_json,prepare_message_id,prepare_payload_json FROM runtime_session WHERE runtime_session_id=?",
                (runtime_session_id,),
            ).fetchone()
            if existing:
                if bytes(existing[0]) != identity_bytes or existing[1] != prepare_message["messageId"] or bytes(existing[2]) != payload_bytes:
                    raise CommitConflict("runtimeSessionId was registered with different PREPARE content")
                return False
            try:
                self.db.execute(
                    """
                    INSERT INTO runtime_session(
                      runtime_session_id,system_id,device_id,task_id,task_item_id,execution_attempt,
                      monotonic_epoch_id,package_version,core_protocol_version,identity_json,
                      prepare_message_id,prepare_payload_json,game_code,runtime_config_hash,
                      planned_batch_count,design_max_level,session_start_level,duration_ms,
                      session_seed,generator_version,game_config_schema_id,registered_at_uptime_ms,status
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE')
                    """,
                    (
                        runtime_session_id, identity["systemId"], identity["deviceId"], identity["taskId"],
                        identity["taskItemId"], identity["executionAttempt"], identity["monotonicEpochId"],
                        identity["packageVersion"], identity["coreProtocolVersion"], identity_bytes,
                        prepare_message["messageId"], payload_bytes, payload["gameCode"], payload["runtimeConfigHash"],
                        payload["plannedBatchCount"], payload["designMaxLevel"], payload["sessionStartLevel"],
                        payload["durationMs"], payload["sessionSeed"], payload["generatorVersion"],
                        payload["gameConfigSchemaId"], received,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise CommitConflict("execution attempt or PREPARE message is already bound to another runtime session") from exc
        return True

    def _session(self, runtime_session_id: str) -> dict[str, Any]:
        row = self.db.execute(
            """
            SELECT identity_json,game_code,runtime_config_hash,planned_batch_count,design_max_level,
                   session_start_level,duration_ms,status
            FROM runtime_session WHERE runtime_session_id=?
            """,
            (runtime_session_id,),
        ).fetchone()
        if not row:
            raise CommitConflict("runtime session was not durably registered from PREPARE")
        return {
            "identity": strict_json_loads(bytes(row[0])),
            "gameCode": row[1],
            "runtimeConfigHash": row[2],
            "plannedBatchCount": int(row[3]),
            "designMaxLevel": int(row[4]),
            "sessionStartLevel": int(row[5]),
            "durationMs": int(row[6]),
            "status": row[7],
        }

    @staticmethod
    def _assert_identity(session: dict[str, Any], identity: dict[str, Any]) -> None:
        candidate = {field: identity[field] for field in IDENTITY_FIELDS}
        if candidate != session["identity"]:
            raise CommitConflict("identity differs from durably registered PREPARE")

    def record_batch_event(self, message: dict[str, Any], *, received_at_uptime_ms: int) -> bool:
        validate_schema(message, "a620_training_runtime_message.schema.json")
        if message["messageType"] != "BATCH_CLOSED" or message["senderRole"] != "COCOS_RUNTIME":
            raise CommitConflict("batch evidence requires a Cocos BATCH_CLOSED event")
        if message["correlationId"] is not None:
            raise CommitConflict("BATCH_CLOSED correlationId must be null")
        if not message["sentAtUptimeMs"] <= received_at_uptime_ms <= 9_007_199_254_740_991:
            raise CommitConflict("BATCH_CLOSED receive time is outside the valid clock range")

        identity = _identity_from_message(message)
        runtime_session_id = identity["runtimeSessionId"]
        batch = message["payload"]
        projection = deepcopy(batch)
        supplied_hash = projection.pop("batchPayloadSha256")
        if canonical_sha256(projection) != supplied_hash:
            raise CommitConflict("BATCH_CLOSED batchPayloadSha256 is not self-consistent")
        encoded = canonical_bytes(batch)
        ordinal = batch["batchOrdinal"]

        with self._transaction():
            session = self._session(runtime_session_id)
            self._assert_identity(session, identity)
            if session["status"] != "ACTIVE":
                raise CommitConflict("batch evidence cannot be appended after execution finalization")
            if not 1 <= ordinal <= session["plannedBatchCount"]:
                raise CommitConflict("batch ordinal is outside the registered plan")
            if not 0 < batch["closedAtActiveMs"] <= session["durationMs"]:
                raise CommitConflict("batch close time is outside the registered active duration")

            existing = self.db.execute(
                """
                SELECT batch_ordinal,message_id,sender_seq,received_at_uptime_ms,closed_at_active_ms,payload_sha256,payload_json
                FROM batch_evidence
                WHERE runtime_session_id=? AND (batch_ordinal=? OR message_id=? OR sender_seq=?)
                """,
                (runtime_session_id, ordinal, message["messageId"], message["senderSeq"]),
            ).fetchone()
            if existing:
                exact = (
                    int(existing[0]) == ordinal
                    and existing[1] == message["messageId"]
                    and int(existing[2]) == message["senderSeq"]
                    # Receipt time belongs to the Android transport attempt,
                    # not to the canonical Cocos event. A later exact replay
                    # keeps the first durable receipt timestamp.
                    and int(existing[4]) == batch["closedAtActiveMs"]
                    and existing[5] == supplied_hash
                    and bytes(existing[6]) == encoded
                )
                if not exact:
                    raise CommitConflict(f"batch evidence/message/sequence conflict at ordinal {ordinal}")
                return False

            previous = self.db.execute(
                """
                SELECT COALESCE(MAX(batch_ordinal),0),COALESCE(MAX(sender_seq),0),COALESCE(MAX(closed_at_active_ms),-1)
                FROM batch_evidence WHERE runtime_session_id=?
                """,
                (runtime_session_id,),
            ).fetchone()
            if ordinal != int(previous[0]) + 1:
                raise CommitConflict(f"batch evidence must be contiguous: expected {int(previous[0]) + 1}, got {ordinal}")
            if message["senderSeq"] <= int(previous[1]):
                raise CommitConflict("BATCH_CLOSED senderSeq must increase")
            if batch["closedAtActiveMs"] <= int(previous[2]):
                raise CommitConflict("BATCH_CLOSED active close time must increase")

            self.db.execute(
                """
                INSERT INTO batch_evidence(
                  runtime_session_id,batch_ordinal,message_id,sender_seq,received_at_uptime_ms,
                  closed_at_active_ms,payload_sha256,payload_json
                ) VALUES(?,?,?,?,?,?,?,?)
                """,
                (
                    runtime_session_id, ordinal, message["messageId"], message["senderSeq"],
                    received_at_uptime_ms, batch["closedAtActiveMs"], supplied_hash, encoded,
                ),
            )
        return True

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
        with self._transaction():
            session = self._session(runtime_session_id)
            self._assert_identity(session, identity)
            if self.db.execute("SELECT 1 FROM execution_outcome WHERE runtime_session_id=?", (runtime_session_id,)).fetchone():
                raise CommitConflict("execution already has an interrupted/discarded outcome")

            ledger = self._ledger(runtime_session_id)
            validate_game_payload(
                game_payload,
                evidence_ledger=ledger,
                expected_game_code=session["gameCode"],
                expected_runtime_config_hash=session["runtimeConfigHash"],
                expected_planned_batch_count=session["plannedBatchCount"],
                expected_design_max_level=session["designMaxLevel"],
                expected_session_start_level=session["sessionStartLevel"],
                expected_duration_ms=session["durationMs"],
            )
            payload_hash = canonical_sha256(game_payload)

            existing = self.db.execute(
                "SELECT result_id,payload_sha256,result_json FROM formal_result WHERE runtime_session_id=? OR result_id=?",
                (runtime_session_id, result_id),
            ).fetchone()
            if existing:
                existing_result = strict_json_loads(bytes(existing[2]))
                identity_matches = all(existing_result[field] == identity[field] for field in IDENTITY_FIELDS)
                if (
                    existing[0] != result_id
                    or existing[1] != payload_hash
                    or existing_result["resultId"] != result_id
                    or existing_result["resultPayloadSha256"] != payload_hash
                    or existing_result["gamePayload"] != game_payload
                    or not identity_matches
                ):
                    raise CommitConflict("resultId/runtimeSessionId already committed with different content")
                return CommitAck(result_id, payload_hash, existing_result["savedAtUtc"], existing_result["savedAtUptimeMs"], True)

            if session["status"] != "ACTIVE":
                raise CommitConflict("runtime session is already finalized")
            last_receive = self.db.execute(
                "SELECT COALESCE(MAX(received_at_uptime_ms),0) FROM batch_evidence WHERE runtime_session_id=?",
                (runtime_session_id,),
            ).fetchone()[0]
            if committed_at_uptime_ms < int(last_receive):
                raise CommitConflict("formal result commit predates received batch evidence")

            result = build_formal_result(
                identity=identity,
                payload=game_payload,
                result_id=result_id,
                saved_at_utc=committed_at_utc,
                saved_at_uptime_ms=committed_at_uptime_ms,
            )
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
            self.db.execute(
                "INSERT INTO formal_result(result_id,runtime_session_id,payload_sha256,result_json) VALUES(?,?,?,?)",
                (result_id, runtime_session_id, payload_hash, canonical_bytes(result)),
            )
            if inject_failure_after_result:
                raise RuntimeError("injected failure after formal_result insert")
            self.db.execute("INSERT INTO sync_queue(result_id,sync_state) VALUES(?, 'PENDING_UPLOAD')", (result_id,))
            self.db.execute(
                "INSERT INTO controller_state(runtime_session_id,state_json) VALUES(?,?)",
                (runtime_session_id, canonical_bytes(controller_state)),
            )
            self.db.execute("UPDATE runtime_session SET status='RESULT_COMMITTED' WHERE runtime_session_id=?", (runtime_session_id,))
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
        with self._transaction():
            session = self._session(runtime_session_id)
            self._assert_identity(session, identity)
            if game_code != session["gameCode"]:
                raise CommitConflict("execution outcome gameCode differs from PREPARE")
            if not 0 <= active_elapsed_ms <= session["durationMs"]:
                raise CommitConflict("execution outcome activeElapsedMs is outside the registered duration")
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
            outcome_bytes = canonical_bytes(outcome)
            existing = self.db.execute(
                "SELECT completion_state,outcome_json FROM execution_outcome WHERE runtime_session_id=?",
                (runtime_session_id,),
            ).fetchone()
            if existing:
                if existing[0] != completion_state or bytes(existing[1]) != outcome_bytes:
                    raise CommitConflict("execution outcome replay differs from committed content")
                return outcome
            if session["status"] != "ACTIVE":
                raise CommitConflict("runtime session is already finalized")

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
            self.db.execute(
                "INSERT INTO execution_outcome(runtime_session_id,completion_state,outcome_json) VALUES(?,?,?)",
                (runtime_session_id, completion_state, outcome_bytes),
            )
            self.db.execute(
                "INSERT INTO controller_state(runtime_session_id,state_json) VALUES(?,?)",
                (runtime_session_id, canonical_bytes(controller_state)),
            )
            self.db.execute("UPDATE runtime_session SET status='OUTCOME_COMMITTED' WHERE runtime_session_id=?", (runtime_session_id,))
            return outcome

    def counts(self) -> dict[str, int]:
        tables = (
            "runtime_session",
            "batch_evidence",
            "formal_result",
            "execution_outcome",
            "sync_queue",
            "controller_state",
        )
        return {table: int(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) for table in tables}
