from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from .errors import (
    InvalidState, LeaseBusy, ProtocolConflict, StaleFence,
    TerminalRuntime, UnknownRuntime,
)
from .sqlite_support import (
    canonical_json_bytes, canonical_sha256, connect,
    immediate_transaction, json_blob, load_blob,
)

Reducer = Callable[[dict[str, Any], dict[str, Any]], tuple[dict[str, Any], dict[str, Any]]]

@dataclass(frozen=True)
class RuntimeLease:
    runtime_session_id: str
    owner_id: str
    fence_token: int
    lease_until_ms: int

@dataclass(frozen=True)
class ClaimedOutboxMessage:
    message_id: str
    runtime_session_id: str
    canonical_bytes: bytes
    attempt_count: int
    claim_generation: int
    claim_until_ms: int
    required_acks: tuple[str, ...]
    received_acks: tuple[str, ...]

class RuntimeCoordinationStore:
    """SQLite reference for concurrent runtime coordination.

    Every state-changing operation uses BEGIN IMMEDIATE. Runtime leases and
    row claim generations are fencing tokens: a stale worker may finish its
    CPU work, but cannot commit after another worker takes ownership.
    """

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        conn = connect(self.db_path)
        try:
            self._create_schema(conn)
        finally:
            conn.close()

    @staticmethod
    def _create_schema(conn: sqlite3.Connection) -> None:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS runtime_session (
            runtime_session_id TEXT PRIMARY KEY,
            task_item_id TEXT NOT NULL,
            execution_attempt INTEGER NOT NULL CHECK(execution_attempt >= 1),
            monotonic_epoch_id TEXT NOT NULL,
            lifecycle TEXT NOT NULL CHECK(lifecycle IN ('ACTIVE','TERMINAL')),
            terminal_reason TEXT,
            state_revision INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE(task_item_id, execution_attempt)
        );
        CREATE TABLE IF NOT EXISTS runtime_lease (
            runtime_session_id TEXT PRIMARY KEY
                REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
            owner_id TEXT NOT NULL,
            fence_token INTEGER NOT NULL CHECK(fence_token >= 1),
            lease_until_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_snapshot (
            runtime_session_id TEXT PRIMARY KEY
                REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
            revision INTEGER NOT NULL,
            snapshot_json BLOB NOT NULL,
            snapshot_sha256 TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inbox_message (
            message_id TEXT PRIMARY KEY,
            runtime_session_id TEXT NOT NULL
                REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
            canonical_sha256 TEXT NOT NULL,
            sender_role TEXT NOT NULL,
            sender_seq INTEGER NOT NULL CHECK(sender_seq >= 0),
            outcome_json BLOB NOT NULL,
            applied_revision INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE(runtime_session_id, sender_role, sender_seq)
        );
        CREATE TABLE IF NOT EXISTS outbox_message (
            message_id TEXT PRIMARY KEY,
            runtime_session_id TEXT NOT NULL
                REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
            canonical_bytes BLOB NOT NULL,
            canonical_sha256 TEXT NOT NULL,
            required_acks_json BLOB NOT NULL,
            received_acks_json BLOB NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('PENDING','IN_FLIGHT','ACKED','CANCELLED')),
            next_attempt_ms INTEGER NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            claim_owner TEXT,
            claim_generation INTEGER NOT NULL DEFAULT 0,
            claim_until_ms INTEGER,
            terminal_note TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outbox_due_idx
            ON outbox_message(status, next_attempt_ms, claim_until_ms);
        CREATE TABLE IF NOT EXISTS watchdog_obligation (
            obligation_id TEXT PRIMARY KEY,
            runtime_session_id TEXT NOT NULL
                REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
            source_message_id TEXT,
            kind TEXT NOT NULL,
            deadline_ms INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('ACTIVE','SATISFIED','FIRED','CANCELLED')),
            details_json BLOB NOT NULL,
            fired_reason TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE(runtime_session_id, kind, source_message_id)
        );
        CREATE INDEX IF NOT EXISTS watchdog_due_idx
            ON watchdog_obligation(status, deadline_ms);
        CREATE TABLE IF NOT EXISTS execution_outcome (
            runtime_session_id TEXT PRIMARY KEY
                REFERENCES runtime_session(runtime_session_id) ON DELETE CASCADE,
            completion_state TEXT NOT NULL CHECK(completion_state IN ('INTERRUPTED','DISCARDED')),
            reason TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        );
        """)

    def _conn(self) -> sqlite3.Connection:
        return connect(self.db_path)

    def register_runtime(
        self, *, runtime_session_id: str, task_item_id: str,
        execution_attempt: int, monotonic_epoch_id: str,
        initial_snapshot: dict[str, Any], now_ms: int,
    ) -> None:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                row = conn.execute(
                    "SELECT * FROM runtime_session WHERE runtime_session_id=?",
                    (runtime_session_id,),
                ).fetchone()
                if row:
                    expected = (task_item_id, execution_attempt, monotonic_epoch_id)
                    actual = (row['task_item_id'], row['execution_attempt'], row['monotonic_epoch_id'])
                    if actual != expected:
                        raise ProtocolConflict("runtimeSessionId reused with different identity")
                    return
                max_attempt = conn.execute(
                    "SELECT MAX(execution_attempt) AS value FROM runtime_session WHERE task_item_id=?",
                    (task_item_id,),
                ).fetchone()['value']
                if max_attempt is not None and execution_attempt <= max_attempt:
                    raise ProtocolConflict("executionAttempt must increase for a task item")
                older_active = conn.execute(
                    "SELECT runtime_session_id FROM runtime_session WHERE task_item_id=? AND lifecycle='ACTIVE'",
                    (task_item_id,),
                ).fetchall()
                for old_runtime in older_active:
                    self._terminalize_tx(
                        conn, old_runtime['runtime_session_id'], 'INTERRUPTED',
                        'EXECUTION_SUPERSEDED_BY_NEW_ATTEMPT', now_ms,
                    )
                blob = canonical_json_bytes(initial_snapshot)
                digest = canonical_sha256(initial_snapshot)
                conn.execute(
                    "INSERT INTO runtime_session VALUES (?,?,?,?, 'ACTIVE',NULL,0,?,?)",
                    (runtime_session_id, task_item_id, execution_attempt,
                     monotonic_epoch_id, now_ms, now_ms),
                )
                conn.execute(
                    "INSERT INTO runtime_snapshot VALUES (?,?,?,?,?)",
                    (runtime_session_id, 0, blob, digest, now_ms),
                )
        finally:
            conn.close()

    def acquire_runtime_lease(
        self, runtime_session_id: str, owner_id: str, *,
        monotonic_epoch_id: str, now_ms: int, lease_ms: int = 5000,
    ) -> RuntimeLease:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                runtime = self._runtime(conn, runtime_session_id)
                self._require_active(runtime)
                if runtime['monotonic_epoch_id'] != monotonic_epoch_id:
                    raise StaleFence("monotonic epoch does not match runtime")
                row = conn.execute(
                    "SELECT * FROM runtime_lease WHERE runtime_session_id=?",
                    (runtime_session_id,),
                ).fetchone()
                until = now_ms + lease_ms
                if row is None:
                    fence = 1
                    conn.execute(
                        "INSERT INTO runtime_lease VALUES (?,?,?,?,?)",
                        (runtime_session_id, owner_id, fence, until, now_ms),
                    )
                elif row['owner_id'] == owner_id and row['lease_until_ms'] > now_ms:
                    fence = row['fence_token']
                    conn.execute(
                        "UPDATE runtime_lease SET lease_until_ms=?,updated_at_ms=? WHERE runtime_session_id=?",
                        (until, now_ms, runtime_session_id),
                    )
                elif row['lease_until_ms'] <= now_ms:
                    fence = row['fence_token'] + 1
                    conn.execute(
                        "UPDATE runtime_lease SET owner_id=?,fence_token=?,lease_until_ms=?,updated_at_ms=? WHERE runtime_session_id=?",
                        (owner_id, fence, until, now_ms, runtime_session_id),
                    )
                else:
                    raise LeaseBusy(f"runtime lease held by {row['owner_id']}")
                return RuntimeLease(runtime_session_id, owner_id, fence, until)
        finally:
            conn.close()

    def apply_inbound_message(
        self, *, runtime_session_id: str, owner_id: str, fence_token: int,
        now_ms: int, message_id: str, sender_role: str, sender_seq: int,
        payload: dict[str, Any], reducer: Reducer, fault_at: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
        digest = canonical_sha256(payload)
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                runtime = self._runtime(conn, runtime_session_id)
                self._require_active(runtime)
                self._assert_lease(conn, runtime_session_id, owner_id, fence_token, now_ms)
                existing = conn.execute(
                    "SELECT * FROM inbox_message WHERE message_id=?", (message_id,)
                ).fetchone()
                if existing:
                    if existing['canonical_sha256'] != digest:
                        raise ProtocolConflict("same messageId has different canonical content")
                    return load_blob(existing['outcome_json']), True
                same_seq = conn.execute(
                    "SELECT message_id,canonical_sha256 FROM inbox_message WHERE runtime_session_id=? AND sender_role=? AND sender_seq=?",
                    (runtime_session_id, sender_role, sender_seq),
                ).fetchone()
                if same_seq:
                    raise ProtocolConflict("sender sequence reused by a different message")
                snap = conn.execute(
                    "SELECT * FROM runtime_snapshot WHERE runtime_session_id=?",
                    (runtime_session_id,),
                ).fetchone()
                old_snapshot = load_blob(snap['snapshot_json'])
                new_snapshot, outcome = reducer(old_snapshot, payload)
                new_blob = canonical_json_bytes(new_snapshot)
                outcome_blob = canonical_json_bytes(outcome)
                new_revision = snap['revision'] + 1
                conn.execute(
                    "INSERT INTO inbox_message VALUES (?,?,?,?,?,?,?,?,?)",
                    (message_id, runtime_session_id, digest, sender_role,
                     sender_seq, outcome_blob, new_revision, now_ms, now_ms),
                )
                if fault_at == 'after_inbox_insert':
                    raise RuntimeError('fault injection: after_inbox_insert')
                changed = conn.execute(
                    "UPDATE runtime_snapshot SET revision=?,snapshot_json=?,snapshot_sha256=?,updated_at_ms=? WHERE runtime_session_id=? AND revision=?",
                    (new_revision, new_blob, canonical_sha256(new_snapshot), now_ms,
                     runtime_session_id, snap['revision']),
                ).rowcount
                if changed != 1:
                    raise StaleFence("snapshot revision changed concurrently")
                conn.execute(
                    "UPDATE runtime_session SET state_revision=?,updated_at_ms=? WHERE runtime_session_id=? AND state_revision=?",
                    (new_revision, now_ms, runtime_session_id, snap['revision']),
                )
                if fault_at == 'after_snapshot_update':
                    raise RuntimeError('fault injection: after_snapshot_update')
                if fault_at == 'before_commit':
                    raise RuntimeError('fault injection: before_commit')
                return outcome, False
        finally:
            conn.close()

    def enqueue_outbox(
        self, *, runtime_session_id: str, message_id: str,
        message: dict[str, Any], required_acks: Sequence[str],
        next_attempt_ms: int, now_ms: int,
    ) -> None:
        canonical = canonical_json_bytes(message)
        digest = canonical_sha256(message)
        required = sorted(set(required_acks))
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                runtime = self._runtime(conn, runtime_session_id)
                self._require_active(runtime)
                existing = conn.execute(
                    "SELECT * FROM outbox_message WHERE message_id=?", (message_id,)
                ).fetchone()
                if existing:
                    if (existing['canonical_sha256'] != digest or
                        load_blob(existing['required_acks_json']) != required):
                        raise ProtocolConflict("outbox messageId reused with different content or obligations")
                    return
                conn.execute(
                    "INSERT INTO outbox_message VALUES (?,?,?,?,?,?, 'PENDING',?,0,NULL,0,NULL,NULL,?,?)",
                    (message_id, runtime_session_id, canonical, digest,
                     json_blob(required), json_blob([]), next_attempt_ms,
                     now_ms, now_ms),
                )
        finally:
            conn.close()

    def add_watchdog(
        self, *, obligation_id: str, runtime_session_id: str,
        kind: str, deadline_ms: int, now_ms: int,
        source_message_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                runtime = self._runtime(conn, runtime_session_id)
                self._require_active(runtime)
                conn.execute(
                    "INSERT OR IGNORE INTO watchdog_obligation VALUES (?,?,?,?,?, 'ACTIVE',?,NULL,?,?)",
                    (obligation_id, runtime_session_id, source_message_id,
                     kind, deadline_ms, json_blob(details or {}), now_ms, now_ms),
                )
        finally:
            conn.close()

    def dispatch_cycle(
        self, *, worker_id: str, now_ms: int,
        claim_lease_ms: int = 5000, limit: int = 128,
    ) -> tuple[list[ClaimedOutboxMessage], list[str]]:
        """Fire expired watchdogs first, then claim retries.

        This single transaction enforces WATCHDOG_BEFORE_RETRY when both
        become due at the same uptime millisecond.
        """
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                fired = self._fire_due_watchdogs_tx(conn, now_ms)
                claimed = self._claim_due_outbox_tx(
                    conn, worker_id, now_ms, claim_lease_ms, limit
                )
                return claimed, fired
        finally:
            conn.close()

    def claim_due_outbox(
        self, *, worker_id: str, now_ms: int,
        claim_lease_ms: int = 5000, limit: int = 128,
    ) -> list[ClaimedOutboxMessage]:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                self._fire_due_watchdogs_tx(conn, now_ms)
                return self._claim_due_outbox_tx(
                    conn, worker_id, now_ms, claim_lease_ms, limit
                )
        finally:
            conn.close()

    def _claim_due_outbox_tx(
        self, conn: sqlite3.Connection, worker_id: str, now_ms: int,
        claim_lease_ms: int, limit: int,
    ) -> list[ClaimedOutboxMessage]:
        rows = conn.execute("""
            SELECT o.* FROM outbox_message o
            JOIN runtime_session r ON r.runtime_session_id=o.runtime_session_id
            WHERE r.lifecycle='ACTIVE'
              AND o.next_attempt_ms<=?
              AND (o.status='PENDING' OR (o.status='IN_FLIGHT' AND o.claim_until_ms<=?))
            ORDER BY o.next_attempt_ms,o.created_at_ms,o.message_id
            LIMIT ?
        """, (now_ms, now_ms, limit)).fetchall()
        result: list[ClaimedOutboxMessage] = []
        for row in rows:
            generation = row['claim_generation'] + 1
            until = now_ms + claim_lease_ms
            changed = conn.execute("""
                UPDATE outbox_message
                SET status='IN_FLIGHT',claim_owner=?,claim_generation=?,
                    claim_until_ms=?,attempt_count=attempt_count+1,updated_at_ms=?
                WHERE message_id=? AND claim_generation=?
                  AND (status='PENDING' OR (status='IN_FLIGHT' AND claim_until_ms<=?))
            """, (worker_id, generation, until, now_ms, row['message_id'],
                   row['claim_generation'], now_ms)).rowcount
            if changed != 1:
                continue
            result.append(ClaimedOutboxMessage(
                row['message_id'], row['runtime_session_id'], row['canonical_bytes'],
                row['attempt_count'] + 1, generation, until,
                tuple(load_blob(row['required_acks_json'], [])),
                tuple(load_blob(row['received_acks_json'], [])),
            ))
        return result

    def reschedule_outbox(
        self, *, message_id: str, worker_id: str,
        claim_generation: int, next_attempt_ms: int, now_ms: int,
        reason: str,
    ) -> None:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                row = conn.execute("""
                    SELECT o.*,r.lifecycle FROM outbox_message o
                    JOIN runtime_session r ON r.runtime_session_id=o.runtime_session_id
                    WHERE o.message_id=?
                """, (message_id,)).fetchone()
                if not row:
                    raise InvalidState("unknown outbox message")
                if row['lifecycle'] != 'ACTIVE':
                    conn.execute("UPDATE outbox_message SET status='CANCELLED',terminal_note=?,claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=? WHERE message_id=?",
                                 ('runtime terminal', now_ms, message_id))
                    raise TerminalRuntime("runtime already terminal")
                if (row['status'] != 'IN_FLIGHT' or row['claim_owner'] != worker_id or
                    row['claim_generation'] != claim_generation):
                    raise StaleFence("outbox dispatch claim is stale")
                conn.execute("""
                    UPDATE outbox_message SET status='PENDING',next_attempt_ms=?,
                    claim_owner=NULL,claim_until_ms=NULL,terminal_note=?,updated_at_ms=?
                    WHERE message_id=?
                """, (next_attempt_ms, reason, now_ms, message_id))
        finally:
            conn.close()

    def record_outbox_ack(self, *, message_id: str, ack_kind: str, now_ms: int) -> bool:
        conn = self._conn()
        timed_out = False
        complete = False
        try:
            with immediate_transaction(conn):
                row = conn.execute("""
                    SELECT o.*,r.lifecycle FROM outbox_message o
                    JOIN runtime_session r ON r.runtime_session_id=o.runtime_session_id
                    WHERE o.message_id=?
                """, (message_id,)).fetchone()
                if not row:
                    raise InvalidState("unknown outbox message")
                if row['lifecycle'] != 'ACTIVE' or row['status'] == 'CANCELLED':
                    raise TerminalRuntime("late ACK after terminal outcome")
                # At an equal uptime millisecond the watchdog owns the boundary.
                due = conn.execute("""
                    SELECT 1 FROM watchdog_obligation
                    WHERE runtime_session_id=? AND source_message_id=?
                      AND status='ACTIVE' AND deadline_ms<=?
                    LIMIT 1
                """, (row['runtime_session_id'], message_id, now_ms)).fetchone()
                if due:
                    self._fire_due_watchdogs_tx(conn, now_ms)
                    timed_out = True
                else:
                    required = set(load_blob(row['required_acks_json'], []))
                    if ack_kind not in required:
                        raise ProtocolConflict("ACK is not an obligation of this message")
                    received = set(load_blob(row['received_acks_json'], []))
                    received.add(ack_kind)
                    complete = required.issubset(received)
                    conn.execute("""
                        UPDATE outbox_message SET received_acks_json=?,status=?,
                        next_attempt_ms=?,claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=?
                        WHERE message_id=?
                    """, (json_blob(sorted(received)), 'ACKED' if complete else 'PENDING',
                           now_ms, now_ms, message_id))
                    if complete:
                        conn.execute("""
                            UPDATE watchdog_obligation
                            SET status='SATISFIED',updated_at_ms=?
                            WHERE runtime_session_id=? AND source_message_id=? AND status='ACTIVE'
                        """, (now_ms, row['runtime_session_id'], message_id))
            if timed_out:
                raise TerminalRuntime("ACK arrived at or after watchdog deadline")
            return complete
        finally:
            conn.close()

    def fire_due_watchdogs(self, *, now_ms: int) -> list[str]:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                return self._fire_due_watchdogs_tx(conn, now_ms)
        finally:
            conn.close()

    def _fire_due_watchdogs_tx(self, conn: sqlite3.Connection, now_ms: int) -> list[str]:
        rows = conn.execute("""
            SELECT w.*,r.lifecycle FROM watchdog_obligation w
            JOIN runtime_session r ON r.runtime_session_id=w.runtime_session_id
            WHERE w.status='ACTIVE' AND w.deadline_ms<=?
            ORDER BY w.deadline_ms,w.obligation_id
        """, (now_ms,)).fetchall()
        fired: list[str] = []
        terminalized: set[str] = set()
        for row in rows:
            runtime_id = row['runtime_session_id']
            if row['lifecycle'] != 'ACTIVE' or runtime_id in terminalized:
                conn.execute("UPDATE watchdog_obligation SET status='CANCELLED',updated_at_ms=? WHERE obligation_id=?",
                             (now_ms, row['obligation_id']))
                continue
            if row['source_message_id']:
                outbox = conn.execute(
                    "SELECT status FROM outbox_message WHERE message_id=?",
                    (row['source_message_id'],),
                ).fetchone()
                if outbox and outbox['status'] == 'ACKED':
                    conn.execute("UPDATE watchdog_obligation SET status='SATISFIED',updated_at_ms=? WHERE obligation_id=?",
                                 (now_ms, row['obligation_id']))
                    continue
            reason = f"WATCHDOG_{row['kind']}"
            conn.execute("UPDATE watchdog_obligation SET status='FIRED',fired_reason=?,updated_at_ms=? WHERE obligation_id=?",
                         (reason, now_ms, row['obligation_id']))
            self._terminalize_tx(conn, runtime_id, 'INTERRUPTED', reason, now_ms)
            terminalized.add(runtime_id)
            fired.append(row['obligation_id'])
        return fired

    def terminalize_runtime(
        self, *, runtime_session_id: str, completion_state: str,
        reason: str, now_ms: int,
    ) -> None:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                self._terminalize_tx(conn, runtime_session_id, completion_state, reason, now_ms)
        finally:
            conn.close()

    def _terminalize_tx(
        self, conn: sqlite3.Connection, runtime_session_id: str,
        completion_state: str, reason: str, now_ms: int,
    ) -> None:
        runtime = self._runtime(conn, runtime_session_id)
        if runtime['lifecycle'] == 'TERMINAL':
            existing = conn.execute("SELECT * FROM execution_outcome WHERE runtime_session_id=?",
                                    (runtime_session_id,)).fetchone()
            if existing and (existing['completion_state'], existing['reason']) == (completion_state, reason):
                return
            raise InvalidState("runtime already has a different terminal outcome")
        if completion_state not in {'INTERRUPTED','DISCARDED'}:
            raise InvalidState("invalid terminal completion state")
        conn.execute("UPDATE runtime_session SET lifecycle='TERMINAL',terminal_reason=?,updated_at_ms=? WHERE runtime_session_id=?",
                     (reason, now_ms, runtime_session_id))
        conn.execute("INSERT INTO execution_outcome VALUES (?,?,?,?)",
                     (runtime_session_id, completion_state, reason, now_ms))
        conn.execute("""
            UPDATE outbox_message SET status='CANCELLED',terminal_note=?,
                claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=?
            WHERE runtime_session_id=? AND status!='ACKED'
        """, (reason, now_ms, runtime_session_id))
        conn.execute("""
            UPDATE watchdog_obligation SET status='CANCELLED',updated_at_ms=?
            WHERE runtime_session_id=? AND status='ACTIVE'
        """, (now_ms, runtime_session_id))
        conn.execute("DELETE FROM runtime_lease WHERE runtime_session_id=?", (runtime_session_id,))

    def recover_expired_claims(self, *, now_ms: int) -> tuple[int, int]:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                reset = conn.execute("""
                    UPDATE outbox_message SET status='PENDING',claim_owner=NULL,
                        claim_until_ms=NULL,updated_at_ms=?
                    WHERE status='IN_FLIGHT' AND claim_until_ms<=?
                      AND runtime_session_id IN (
                          SELECT runtime_session_id FROM runtime_session WHERE lifecycle='ACTIVE'
                      )
                """, (now_ms, now_ms)).rowcount
                cancelled = conn.execute("""
                    UPDATE outbox_message SET status='CANCELLED',terminal_note='runtime terminal',
                        claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=?
                    WHERE status='IN_FLIGHT' AND claim_until_ms<=?
                      AND runtime_session_id IN (
                          SELECT runtime_session_id FROM runtime_session WHERE lifecycle='TERMINAL'
                      )
                """, (now_ms, now_ms)).rowcount
                return reset, cancelled
        finally:
            conn.close()

    def snapshot(self, runtime_session_id: str) -> dict[str, Any]:
        conn = self._conn()
        try:
            row = conn.execute("SELECT * FROM runtime_snapshot WHERE runtime_session_id=?",
                               (runtime_session_id,)).fetchone()
            if not row:
                raise UnknownRuntime(runtime_session_id)
            return load_blob(row['snapshot_json'])
        finally:
            conn.close()

    def get_outbox(self, message_id: str) -> dict[str, Any]:
        conn = self._conn()
        try:
            row = conn.execute("SELECT * FROM outbox_message WHERE message_id=?", (message_id,)).fetchone()
            if not row:
                raise InvalidState("unknown outbox message")
            return dict(row)
        finally:
            conn.close()

    def get_runtime(self, runtime_session_id: str) -> dict[str, Any]:
        conn = self._conn()
        try:
            return dict(self._runtime(conn, runtime_session_id))
        finally:
            conn.close()

    def quick_check(self) -> str:
        conn = self._conn()
        try:
            return conn.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            conn.close()

    @staticmethod
    def _runtime(conn: sqlite3.Connection, runtime_session_id: str) -> sqlite3.Row:
        row = conn.execute("SELECT * FROM runtime_session WHERE runtime_session_id=?",
                           (runtime_session_id,)).fetchone()
        if not row:
            raise UnknownRuntime(runtime_session_id)
        return row

    @staticmethod
    def _require_active(runtime: sqlite3.Row) -> None:
        if runtime['lifecycle'] != 'ACTIVE':
            raise TerminalRuntime(runtime['terminal_reason'] or 'runtime terminal')

    @staticmethod
    def _assert_lease(
        conn: sqlite3.Connection, runtime_session_id: str,
        owner_id: str, fence_token: int, now_ms: int,
    ) -> None:
        row = conn.execute("SELECT * FROM runtime_lease WHERE runtime_session_id=?",
                           (runtime_session_id,)).fetchone()
        if not row:
            raise StaleFence("runtime lease is absent")
        if (row['owner_id'] != owner_id or row['fence_token'] != fence_token or
            row['lease_until_ms'] <= now_ms):
            raise StaleFence("runtime lease owner/fence/expiry mismatch")
