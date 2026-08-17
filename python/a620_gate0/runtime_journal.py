from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterator

from .canonical import canonical_bytes, canonical_sha256, strict_json_loads
from .schema import validate_schema


MAX_REDUCER_SNAPSHOT_BYTES = 4 * 1024 * 1024

IDENTITY_FIELDS = (
    "systemId", "deviceId", "taskId", "taskItemId", "executionAttempt",
    "runtimeSessionId", "packageVersion", "coreProtocolVersion", "monotonicEpochId",
)


class JournalConflict(ValueError):
    pass


class IntakeDisposition(str, Enum):
    NEW = "NEW"
    IDEMPOTENT_REPLAY = "IDEMPOTENT_REPLAY"
    STALE_AUDIT_ONLY = "STALE_AUDIT_ONLY"


@dataclass(frozen=True)
class IntakeResult:
    disposition: IntakeDisposition
    message_id: str
    canonical_sha256: str
    original_disposition: IntakeDisposition | None = None


@dataclass(frozen=True)
class DurableApplyResult:
    intake: IntakeResult
    reducer_snapshot: dict[str, Any] | None


def _identity(value: dict[str, Any]) -> dict[str, Any]:
    return {field: value[field] for field in IDENTITY_FIELDS}


class DurableRuntimeJournal:
    """Restart-safe message intake and reducer snapshot reference.

    The journal is the durable idempotency boundary that an Android Binder
    adapter must apply before mutating the task/result state. Old execution,
    runtime-session or boot-epoch messages are retained for audit but are
    explicitly classified as non-mutating.
    """

    def __init__(self, path: str | Path) -> None:
        self.db = sqlite3.connect(str(path), isolation_level=None, timeout=5.0)
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS active_runtime (
              singleton INTEGER PRIMARY KEY CHECK(singleton=1),
              identity_json BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_message_journal (
              message_id TEXT PRIMARY KEY,
              runtime_session_id TEXT NOT NULL,
              sender_role TEXT NOT NULL,
              sender_seq INTEGER NOT NULL,
              sent_at_uptime_ms INTEGER NOT NULL,
              canonical_sha256 TEXT NOT NULL,
              canonical_json BLOB NOT NULL,
              disposition TEXT NOT NULL CHECK(disposition IN ('NEW','STALE_AUDIT_ONLY'))
            );
            CREATE INDEX IF NOT EXISTS journal_runtime_sender
              ON runtime_message_journal(runtime_session_id,sender_role,sender_seq);
            CREATE TABLE IF NOT EXISTS sender_cursor (
              runtime_session_id TEXT NOT NULL,
              sender_role TEXT NOT NULL,
              last_sender_seq INTEGER NOT NULL,
              last_sent_at_uptime_ms INTEGER NOT NULL,
              PRIMARY KEY(runtime_session_id,sender_role)
            );
            CREATE TABLE IF NOT EXISTS reducer_snapshot (
              runtime_session_id TEXT PRIMARY KEY,
              snapshot_sha256 TEXT NOT NULL,
              snapshot_json BLOB NOT NULL
            );
            """
        )

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def activate(self, identity: dict[str, Any], *, replace: bool = False) -> None:
        candidate = canonical_bytes({field: identity[field] for field in IDENTITY_FIELDS})
        with self._transaction():
            existing = self.db.execute("SELECT identity_json FROM active_runtime WHERE singleton=1").fetchone()
            if existing and bytes(existing[0]) == candidate:
                return
            if existing:
                current = strict_json_loads(bytes(existing[0]))
                if current["runtimeSessionId"] == identity["runtimeSessionId"]:
                    raise JournalConflict("runtimeSessionId cannot be reused for a different identity")
                same_item = (
                    current["systemId"] == identity["systemId"]
                    and current["deviceId"] == identity["deviceId"]
                    and current["taskId"] == identity["taskId"]
                    and current["taskItemId"] == identity["taskItemId"]
                )
                if same_item and identity["executionAttempt"] <= current["executionAttempt"]:
                    raise JournalConflict("replacement executionAttempt must strictly increase for the same task item")
                if not replace:
                    raise JournalConflict("a different runtime is already active")
            self.db.execute(
                "INSERT INTO active_runtime(singleton,identity_json) VALUES(1,?) "
                "ON CONFLICT(singleton) DO UPDATE SET identity_json=excluded.identity_json",
                (candidate,),
            )

    def active_identity(self) -> dict[str, Any] | None:
        row = self.db.execute("SELECT identity_json FROM active_runtime WHERE singleton=1").fetchone()
        return None if row is None else strict_json_loads(bytes(row[0]))

    def _ingest_in_transaction(
        self,
        message: dict[str, Any],
        *,
        encoded: bytes,
        digest: str,
    ) -> IntakeResult:
        message_id = message["messageId"]
        existing = self.db.execute(
            "SELECT canonical_sha256,canonical_json,disposition FROM runtime_message_journal WHERE message_id=?",
            (message_id,),
        ).fetchone()
        if existing:
            if existing[0] != digest or bytes(existing[1]) != encoded:
                raise JournalConflict("messageId was reused with different canonical content")
            return IntakeResult(
                IntakeDisposition.IDEMPOTENT_REPLAY,
                message_id,
                digest,
                IntakeDisposition(existing[2]),
            )

        active_row = self.db.execute("SELECT identity_json FROM active_runtime WHERE singleton=1").fetchone()
        if active_row is None:
            raise JournalConflict("no active runtime identity is registered")
        active = strict_json_loads(bytes(active_row[0]))
        disposition = IntakeDisposition.NEW if _identity(message) == active else IntakeDisposition.STALE_AUDIT_ONLY

        if disposition is IntakeDisposition.NEW:
            cursor = self.db.execute(
                "SELECT last_sender_seq,last_sent_at_uptime_ms FROM sender_cursor WHERE runtime_session_id=? AND sender_role=?",
                (message["runtimeSessionId"], message["senderRole"]),
            ).fetchone()
            if cursor:
                if message["senderSeq"] <= int(cursor[0]):
                    raise JournalConflict("first-seen senderSeq is not strictly increasing")
                if message["sentAtUptimeMs"] < int(cursor[1]):
                    raise JournalConflict("first-seen sender uptime moved backwards")
            self.db.execute(
                """
                INSERT INTO sender_cursor(runtime_session_id,sender_role,last_sender_seq,last_sent_at_uptime_ms)
                VALUES(?,?,?,?)
                ON CONFLICT(runtime_session_id,sender_role) DO UPDATE SET
                  last_sender_seq=excluded.last_sender_seq,
                  last_sent_at_uptime_ms=excluded.last_sent_at_uptime_ms
                """,
                (message["runtimeSessionId"], message["senderRole"], message["senderSeq"], message["sentAtUptimeMs"]),
            )

        self.db.execute(
            """
            INSERT INTO runtime_message_journal(
              message_id,runtime_session_id,sender_role,sender_seq,sent_at_uptime_ms,
              canonical_sha256,canonical_json,disposition
            ) VALUES(?,?,?,?,?,?,?,?)
            """,
            (
                message_id, message["runtimeSessionId"], message["senderRole"], message["senderSeq"],
                message["sentAtUptimeMs"], digest, encoded, disposition.value,
            ),
        )
        return IntakeResult(disposition, message_id, digest)

    def ingest(self, message: dict[str, Any]) -> IntakeResult:
        """Durably classify one message without applying reducer state.

        Production adapters should normally use :meth:`apply` so active-message
        journaling and the resulting reducer checkpoint share one SQLite
        transaction. This lower-level method remains useful for audit-only
        ingestion and focused protocol tests.
        """

        validate_schema(message, "a620_training_runtime_message.schema.json")
        encoded = canonical_bytes(message)
        digest = canonical_sha256(message)
        with self._transaction():
            return self._ingest_in_transaction(message, encoded=encoded, digest=digest)

    def apply(
        self,
        message: dict[str, Any],
        *,
        inject_failure_after_journal: bool = False,
    ) -> DurableApplyResult:
        """Atomically journal an active message and checkpoint the reducer.

        The message row, sender cursor and post-message reducer snapshot commit
        together. A crash or validation failure cannot leave a message marked
        as consumed while the durable reducer remains one transition behind.
        Stale executions are retained for audit but never mutate the active
        reducer snapshot.
        """

        from .flow_validator import FlowValidator, ValidationError

        validate_schema(message, "a620_training_runtime_message.schema.json")
        encoded = canonical_bytes(message)
        digest = canonical_sha256(message)
        with self._transaction():
            intake = self._ingest_in_transaction(message, encoded=encoded, digest=digest)
            runtime_session_id = message["runtimeSessionId"]

            if intake.disposition is IntakeDisposition.IDEMPOTENT_REPLAY:
                active_row = self.db.execute("SELECT identity_json FROM active_runtime WHERE singleton=1").fetchone()
                active = None if active_row is None else strict_json_loads(bytes(active_row[0]))
                # A replay from a runtime that has since been superseded stays
                # audit-only even when its original disposition was NEW. Never
                # hand an old reducer snapshot back to the active controller.
                if active is None or _identity(message) != active:
                    return DurableApplyResult(intake, None)
                if intake.original_disposition is IntakeDisposition.STALE_AUDIT_ONLY:
                    return DurableApplyResult(intake, None)
                row = self.db.execute(
                    "SELECT snapshot_sha256,snapshot_json FROM reducer_snapshot WHERE runtime_session_id=?",
                    (runtime_session_id,),
                ).fetchone()
                if row is None:
                    raise JournalConflict("active message replay has no committed reducer snapshot")
                snapshot = strict_json_loads(bytes(row[1]))
                if canonical_sha256(snapshot) != row[0]:
                    raise JournalConflict("persisted reducer snapshot hash mismatch")
                try:
                    FlowValidator.from_snapshot(snapshot)
                except ValidationError as exc:
                    raise JournalConflict(f"persisted reducer snapshot is invalid: {exc}") from exc
                return DurableApplyResult(intake, snapshot)

            if intake.disposition is IntakeDisposition.STALE_AUDIT_ONLY:
                return DurableApplyResult(intake, None)

            row = self.db.execute(
                "SELECT snapshot_sha256,snapshot_json FROM reducer_snapshot WHERE runtime_session_id=?",
                (runtime_session_id,),
            ).fetchone()
            if row is None:
                reducer = FlowValidator()
            else:
                previous = strict_json_loads(bytes(row[1]))
                if canonical_sha256(previous) != row[0]:
                    raise JournalConflict("persisted reducer snapshot hash mismatch")
                try:
                    reducer = FlowValidator.from_snapshot(previous)
                except ValidationError as exc:
                    raise JournalConflict(f"persisted reducer snapshot is invalid: {exc}") from exc

            try:
                reducer.process(message)
            except ValidationError as exc:
                raise JournalConflict(f"runtime reducer rejected message: {exc}") from exc
            snapshot = reducer.snapshot()
            snapshot_bytes = canonical_bytes(snapshot)
            if len(snapshot_bytes) > MAX_REDUCER_SNAPSHOT_BYTES:
                raise JournalConflict("reducer snapshot exceeds durable size limit")
            snapshot_digest = canonical_sha256(snapshot)
            self.db.execute(
                """
                INSERT INTO reducer_snapshot(runtime_session_id,snapshot_sha256,snapshot_json)
                VALUES(?,?,?)
                ON CONFLICT(runtime_session_id) DO UPDATE SET
                  snapshot_sha256=excluded.snapshot_sha256,
                  snapshot_json=excluded.snapshot_json
                """,
                (runtime_session_id, snapshot_digest, snapshot_bytes),
            )
            if inject_failure_after_journal:
                raise RuntimeError("injected failure after journal insert before transaction commit")
            return DurableApplyResult(intake, snapshot)

    def ingest_wire(self, raw: bytes | str) -> IntakeResult:
        from .wire import parse_runtime_message

        return self.ingest(parse_runtime_message(raw))

    def apply_wire(self, raw: bytes | str) -> DurableApplyResult:
        from .wire import parse_runtime_message

        return self.apply(parse_runtime_message(raw))

    def save_snapshot(self, identity: dict[str, Any], snapshot: dict[str, Any]) -> str:
        candidate_identity = {field: identity[field] for field in IDENTITY_FIELDS}
        # A durable checkpoint must be a complete, restorable reducer snapshot,
        # not an arbitrary diagnostic object. Validate it before writing and
        # bind the embedded identity to the active runtime to prevent a caller
        # from storing another execution's state under the current session id.
        from .flow_validator import FlowValidator, ValidationError

        try:
            restored = FlowValidator.from_snapshot(snapshot)
        except ValidationError as exc:
            raise JournalConflict(f"invalid reducer snapshot: {exc}") from exc
        if restored.identity != candidate_identity:
            raise JournalConflict("snapshot embedded identity is not the active runtime identity")

        encoded = canonical_bytes(snapshot)
        if len(encoded) > MAX_REDUCER_SNAPSHOT_BYTES:
            raise JournalConflict("reducer snapshot exceeds durable size limit")
        digest = canonical_sha256(snapshot)
        with self._transaction():
            active_row = self.db.execute("SELECT identity_json FROM active_runtime WHERE singleton=1").fetchone()
            active = None if active_row is None else strict_json_loads(bytes(active_row[0]))
            if active is None or candidate_identity != active:
                raise JournalConflict("snapshot identity is not the active runtime")
            self.db.execute(
                """
                INSERT INTO reducer_snapshot(runtime_session_id,snapshot_sha256,snapshot_json)
                VALUES(?,?,?)
                ON CONFLICT(runtime_session_id) DO UPDATE SET
                  snapshot_sha256=excluded.snapshot_sha256,
                  snapshot_json=excluded.snapshot_json
                """,
                (identity["runtimeSessionId"], digest, encoded),
            )
        return digest

    def load_snapshot(self, runtime_session_id: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT snapshot_sha256,snapshot_json FROM reducer_snapshot WHERE runtime_session_id=?",
            (runtime_session_id,),
        ).fetchone()
        if row is None:
            return None
        raw = bytes(row[1])
        if len(raw) > MAX_REDUCER_SNAPSHOT_BYTES:
            raise JournalConflict("persisted reducer snapshot exceeds size limit")
        value = strict_json_loads(raw)
        if canonical_sha256(value) != row[0]:
            raise JournalConflict("persisted reducer snapshot hash mismatch")
        from .flow_validator import FlowValidator, ValidationError

        try:
            restored = FlowValidator.from_snapshot(value)
        except ValidationError as exc:
            raise JournalConflict(f"persisted reducer snapshot is invalid: {exc}") from exc
        if restored.identity is None or restored.identity["runtimeSessionId"] != runtime_session_id:
            raise JournalConflict("persisted reducer snapshot identity does not match its storage key")
        return value

    def counts(self) -> dict[str, int]:
        return {
            table: int(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in ("active_runtime", "runtime_message_journal", "sender_cursor", "reducer_snapshot")
        }
