from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterator

from .canonical import canonical_bytes, canonical_sha256, strict_json_loads
from .generated_profiles import (
    AUDIT_CHAIN_ENTRY_PROJECTION, AUDIT_CHAIN_GENESIS_SHA256, AUDIT_CHAIN_MIGRATION_KEY,
    AUDIT_CHAIN_MIGRATION_VALUE, AUDIT_CHAIN_PROFILE_ID,
)
from .schema import validate_schema


MAX_REDUCER_SNAPSHOT_BYTES = 4 * 1024 * 1024
AUDIT_CHAIN_PROFILE = AUDIT_CHAIN_PROFILE_ID
AUDIT_CHAIN_GENESIS = AUDIT_CHAIN_GENESIS_SHA256
_EXPECTED_AUDIT_PROJECTION = (
    "auditProfile", "journalIndex", "messageId", "runtimeSessionId",
    "senderRole", "senderSeq", "sentAtUptimeMs", "canonicalSha256",
    "disposition", "previousEntrySha256",
)
if tuple(AUDIT_CHAIN_ENTRY_PROJECTION) != _EXPECTED_AUDIT_PROJECTION:
    raise RuntimeError("generated audit-chain entry projection diverged from the reference implementation")

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
            CREATE TABLE IF NOT EXISTS runtime_audit_chain (
              journal_index INTEGER PRIMARY KEY,
              message_id TEXT NOT NULL UNIQUE,
              previous_entry_sha256 TEXT NOT NULL,
              entry_sha256 TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_audit_anchor (
              singleton INTEGER PRIMARY KEY CHECK(singleton=1),
              entry_count INTEGER NOT NULL,
              head_sha256 TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_schema_metadata (
              metadata_key TEXT PRIMARY KEY,
              metadata_value TEXT NOT NULL
            );
            """
        )
        self.db.execute(
            "INSERT OR IGNORE INTO runtime_audit_anchor(singleton,entry_count,head_sha256) VALUES(1,0,?)",
            (AUDIT_CHAIN_GENESIS,),
        )
        self._ensure_audit_chain()

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

    @staticmethod
    def _audit_projection(
        *,
        journal_index: int,
        message_id: str,
        runtime_session_id: str,
        sender_role: str,
        sender_seq: int,
        sent_at_uptime_ms: int,
        canonical_sha256_value: str,
        disposition: str,
        previous_entry_sha256: str,
    ) -> dict[str, Any]:
        return {
            "auditProfile": AUDIT_CHAIN_PROFILE,
            "journalIndex": journal_index,
            "messageId": message_id,
            "runtimeSessionId": runtime_session_id,
            "senderRole": sender_role,
            "senderSeq": sender_seq,
            "sentAtUptimeMs": sent_at_uptime_ms,
            "canonicalSha256": canonical_sha256_value,
            "disposition": disposition,
            "previousEntrySha256": previous_entry_sha256,
        }

    def _append_audit_in_transaction(self, message: dict[str, Any], digest: str, disposition: str) -> None:
        row = self.db.execute(
            "SELECT journal_index,entry_sha256 FROM runtime_audit_chain ORDER BY journal_index DESC LIMIT 1"
        ).fetchone()
        journal_index = 1 if row is None else int(row[0]) + 1
        previous = AUDIT_CHAIN_GENESIS if row is None else str(row[1])
        projection = self._audit_projection(
            journal_index=journal_index,
            message_id=message["messageId"],
            runtime_session_id=message["runtimeSessionId"],
            sender_role=message["senderRole"],
            sender_seq=message["senderSeq"],
            sent_at_uptime_ms=message["sentAtUptimeMs"],
            canonical_sha256_value=digest,
            disposition=disposition,
            previous_entry_sha256=previous,
        )
        entry_hash = canonical_sha256(projection)
        anchor = self.db.execute(
            "SELECT entry_count,head_sha256 FROM runtime_audit_anchor WHERE singleton=1"
        ).fetchone()
        if anchor is None or int(anchor[0]) != journal_index - 1 or str(anchor[1]) != previous:
            raise JournalConflict("runtime audit anchor diverged before append")
        self.db.execute(
            "INSERT INTO runtime_audit_chain(journal_index,message_id,previous_entry_sha256,entry_sha256) "
            "VALUES(?,?,?,?)",
            (journal_index, message["messageId"], previous, entry_hash),
        )
        self.db.execute(
            "UPDATE runtime_audit_anchor SET entry_count=?,head_sha256=? WHERE singleton=1",
            (journal_index, entry_hash),
        )

    def _ensure_audit_chain(self) -> None:
        """Perform the baseline.3 migration once, then fail closed forever.

        A chain that disappears after the migration marker exists is corruption,
        not another legacy database. This closes the otherwise dangerous case
        where deleting every chain row and resetting the anchor could trigger a
        silent re-backfill on the next process start.
        """

        journal_count = int(self.db.execute("SELECT COUNT(*) FROM runtime_message_journal").fetchone()[0])
        chain_count = int(self.db.execute("SELECT COUNT(*) FROM runtime_audit_chain").fetchone()[0])
        marker_row = self.db.execute(
            "SELECT metadata_value FROM runtime_schema_metadata WHERE metadata_key=?",
            (AUDIT_CHAIN_MIGRATION_KEY,),
        ).fetchone()

        if marker_row is not None:
            if str(marker_row[0]) != AUDIT_CHAIN_MIGRATION_VALUE:
                raise JournalConflict("runtime audit-chain migration marker has an unsupported value")
            if chain_count != journal_count:
                raise JournalConflict("runtime audit chain disappeared or became partial after migration")
            self.verify_audit_chain()
            return

        # Marker absence is accepted only as the one-time baseline.3 migration
        # condition. A partially existing chain is never guessed or repaired.
        if chain_count not in {0, journal_count}:
            raise JournalConflict("runtime audit chain is partial and will not be auto-repaired")
        if chain_count:
            # A pre-marker full chain may come from a short-lived baseline.4
            # development build. Verify it before recording the permanent
            # migration marker; corruption must not cause any write.
            self.verify_audit_chain()
        with self._transaction():
            if chain_count == 0:
                rows = self.db.execute(
                    "SELECT canonical_json,canonical_sha256,disposition FROM runtime_message_journal ORDER BY rowid"
                ).fetchall()
                for raw, digest, disposition in rows:
                    message = strict_json_loads(bytes(raw))
                    self._append_audit_in_transaction(message, str(digest), str(disposition))
            self.db.execute(
                "INSERT INTO runtime_schema_metadata(metadata_key,metadata_value) VALUES(?,?)",
                (AUDIT_CHAIN_MIGRATION_KEY, AUDIT_CHAIN_MIGRATION_VALUE),
            )
        self.verify_audit_chain()

    def verify_audit_chain(self) -> dict[str, Any]:
        quick = self.db.execute("PRAGMA quick_check").fetchone()
        if quick is None or quick[0] != "ok":
            raise JournalConflict(f"SQLite quick_check failed: {quick}")
        rows = self.db.execute(
            """
            SELECT c.journal_index,c.message_id,c.previous_entry_sha256,c.entry_sha256,
                   j.runtime_session_id,j.sender_role,j.sender_seq,j.sent_at_uptime_ms,
                   j.canonical_sha256,j.canonical_json,j.disposition
            FROM runtime_audit_chain c
            JOIN runtime_message_journal j ON j.message_id=c.message_id
            ORDER BY c.journal_index
            """
        ).fetchall()
        journal_count = int(self.db.execute("SELECT COUNT(*) FROM runtime_message_journal").fetchone()[0])
        chain_count = int(self.db.execute("SELECT COUNT(*) FROM runtime_audit_chain").fetchone()[0])
        if len(rows) != journal_count or chain_count != journal_count:
            raise JournalConflict("runtime audit chain does not cover every journal message")
        previous = AUDIT_CHAIN_GENESIS
        for expected_index, row in enumerate(rows, start=1):
            (
                index, message_id, stored_previous, stored_entry, runtime_session_id,
                sender_role, sender_seq, sent_at_uptime_ms, digest, raw, disposition,
            ) = row
            if int(index) != expected_index or stored_previous != previous:
                raise JournalConflict("runtime audit chain order/previous hash mismatch")
            message = strict_json_loads(bytes(raw))
            if canonical_bytes(message) != bytes(raw) or canonical_sha256(message) != digest:
                raise JournalConflict("runtime audit journal canonical message integrity mismatch")
            projection = self._audit_projection(
                journal_index=expected_index,
                message_id=str(message_id),
                runtime_session_id=str(runtime_session_id),
                sender_role=str(sender_role),
                sender_seq=int(sender_seq),
                sent_at_uptime_ms=int(sent_at_uptime_ms),
                canonical_sha256_value=str(digest),
                disposition=str(disposition),
                previous_entry_sha256=str(stored_previous),
            )
            expected_hash = canonical_sha256(projection)
            if stored_entry != expected_hash:
                raise JournalConflict("runtime audit chain entry hash mismatch")
            previous = expected_hash
        anchor = self.db.execute(
            "SELECT entry_count,head_sha256 FROM runtime_audit_anchor WHERE singleton=1"
        ).fetchone()
        if anchor is None or int(anchor[0]) != len(rows) or str(anchor[1]) != previous:
            raise JournalConflict("runtime audit anchor count/head mismatch")
        return {"entryCount": len(rows), "headSha256": previous}

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
        self._append_audit_in_transaction(message, digest, disposition.value)
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
            for table in ("active_runtime", "runtime_message_journal", "runtime_audit_chain", "sender_cursor", "reducer_snapshot")
        }
