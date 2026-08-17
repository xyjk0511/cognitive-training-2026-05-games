from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .canonical import canonical_bytes, canonical_sha256, strict_json_loads
from .generated_profiles import (
    DELIVERY_MAX_PENDING_BYTES_PER_RUNTIME, DELIVERY_MAX_PENDING_PER_RUNTIME,
    DELIVERY_RESPONSE_OBLIGATIONS, DELIVERY_RETAIN_UNTIL_RESULT_COMMITTED,
    DELIVERY_RETRY_CAP_MS, DELIVERY_RETRY_DELAYS_MS,
)
from .schema import validate_schema

RETRY_DELAYS_MS = tuple(DELIVERY_RETRY_DELAYS_MS)
RETRY_DELAY_CAP_MS = DELIVERY_RETRY_CAP_MS
MAX_PENDING_PER_RUNTIME = DELIVERY_MAX_PENDING_PER_RUNTIME
MAX_PENDING_BYTES_PER_RUNTIME = DELIVERY_MAX_PENDING_BYTES_PER_RUNTIME

RESPONSE_OBLIGATIONS: dict[str, tuple[str, ...]] = {
    message_type: tuple(responses)
    for message_type, responses in DELIVERY_RESPONSE_OBLIGATIONS.items()
}
RETAIN_UNTIL_RESULT_COMMITTED = set(DELIVERY_RETAIN_UNTIL_RESULT_COMMITTED)

DURABLE_MESSAGE_TYPES = set(RESPONSE_OBLIGATIONS) | RETAIN_UNTIL_RESULT_COMMITTED


class OutboxConflict(ValueError):
    pass


@dataclass(frozen=True)
class DeliveryAttempt:
    message_id: str
    message_type: str
    runtime_session_id: str
    canonical_json: bytes
    attempt_number: int
    next_attempt_uptime_ms: int


def retry_delay_ms(completed_attempts: int) -> int:
    if completed_attempts < 1:
        raise ValueError("completed_attempts must be >= 1")
    index = min(completed_attempts - 1, len(RETRY_DELAYS_MS) - 1)
    return min(RETRY_DELAYS_MS[index], RETRY_DELAY_CAP_MS)


class DurableMessageOutbox:
    """SQLite-backed exact-byte retry queue for the process boundary.

    It intentionally stores only messages whose loss can strand state or
    formal evidence. Duplicate enqueue is idempotent only when the canonical
    bytes are identical. Claiming a due message advances its deterministic
    retry schedule in the same transaction, so process death cannot allocate a
    new messageId/senderSeq or silently forget the send attempt.
    """

    def __init__(self, path: str | Path) -> None:
        self.db = sqlite3.connect(str(path), isolation_level=None, timeout=5.0)
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS durable_outbox (
              message_id TEXT PRIMARY KEY,
              runtime_session_id TEXT NOT NULL,
              sender_role TEXT NOT NULL,
              sender_seq INTEGER NOT NULL,
              message_type TEXT NOT NULL,
              canonical_sha256 TEXT NOT NULL,
              canonical_json BLOB NOT NULL,
              obligations_json BLOB NOT NULL,
              observed_json BLOB NOT NULL,
              retention_mode TEXT NOT NULL CHECK(retention_mode IN ('UNTIL_RESPONSES','UNTIL_RESULT_COMMIT')),
              status TEXT NOT NULL CHECK(status IN ('PENDING','COMPLETED','CANCELLED')),
              created_uptime_ms INTEGER NOT NULL,
              attempt_count INTEGER NOT NULL DEFAULT 0,
              last_attempt_uptime_ms INTEGER,
              next_attempt_uptime_ms INTEGER NOT NULL,
              completed_uptime_ms INTEGER,
              cancel_reason TEXT
            );
            CREATE INDEX IF NOT EXISTS durable_outbox_due
              ON durable_outbox(status,next_attempt_uptime_ms,created_uptime_ms);
            CREATE INDEX IF NOT EXISTS durable_outbox_runtime
              ON durable_outbox(runtime_session_id,status,message_type);
            CREATE UNIQUE INDEX IF NOT EXISTS durable_outbox_sender_sequence
              ON durable_outbox(runtime_session_id,sender_role,sender_seq);
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

    def enqueue(self, message: dict[str, Any], *, now_uptime_ms: int | None = None) -> bool:
        validate_schema(message, "a620_training_runtime_message.schema.json")
        message_type = message["messageType"]
        if message_type not in DURABLE_MESSAGE_TYPES:
            raise OutboxConflict(f"{message_type} has no durable outbox retention rule")
        encoded = canonical_bytes(message)
        digest = canonical_sha256(message)
        now = message["sentAtUptimeMs"] if now_uptime_ms is None else now_uptime_ms
        if now < 0:
            raise OutboxConflict("now_uptime_ms must be non-negative")
        obligations = list(RESPONSE_OBLIGATIONS.get(message_type, ()))
        retention = "UNTIL_RESPONSES" if obligations else "UNTIL_RESULT_COMMIT"
        obligations_raw = canonical_bytes(obligations)
        observed_raw = canonical_bytes([])

        with self._transaction():
            existing = self.db.execute(
                "SELECT canonical_sha256,canonical_json FROM durable_outbox WHERE message_id=?",
                (message["messageId"],),
            ).fetchone()
            if existing:
                if existing[0] != digest or bytes(existing[1]) != encoded:
                    raise OutboxConflict("messageId was reused with different canonical content")
                return False

            sequence_owner = self.db.execute(
                "SELECT message_id FROM durable_outbox WHERE runtime_session_id=? AND sender_role=? AND sender_seq=?",
                (message["runtimeSessionId"], message["senderRole"], message["senderSeq"]),
            ).fetchone()
            if sequence_owner is not None:
                raise OutboxConflict(
                    f"senderSeq is already owned by messageId {sequence_owner[0]} in this runtime"
                )

            count, total_bytes = self.db.execute(
                "SELECT COUNT(*),COALESCE(SUM(length(canonical_json)),0) FROM durable_outbox "
                "WHERE runtime_session_id=? AND status='PENDING'",
                (message["runtimeSessionId"],),
            ).fetchone()
            if int(count) >= MAX_PENDING_PER_RUNTIME:
                raise OutboxConflict("runtime pending outbox message budget exceeded")
            if int(total_bytes) + len(encoded) > MAX_PENDING_BYTES_PER_RUNTIME:
                raise OutboxConflict("runtime pending outbox byte budget exceeded")

            self.db.execute(
                """
                INSERT INTO durable_outbox(
                  message_id,runtime_session_id,sender_role,sender_seq,message_type,
                  canonical_sha256,canonical_json,obligations_json,observed_json,
                  retention_mode,status,created_uptime_ms,next_attempt_uptime_ms
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    message["messageId"], message["runtimeSessionId"], message["senderRole"],
                    message["senderSeq"], message_type, digest, encoded, obligations_raw,
                    observed_raw, retention, "PENDING", now, now,
                ),
            )
        return True

    def claim_due(self, now_uptime_ms: int, *, limit: int = 64) -> list[DeliveryAttempt]:
        if now_uptime_ms < 0 or not 1 <= limit <= 1024:
            raise ValueError("invalid outbox claim arguments")
        attempts: list[DeliveryAttempt] = []
        with self._transaction():
            rows = self.db.execute(
                """
                SELECT message_id,message_type,runtime_session_id,canonical_json,attempt_count
                FROM durable_outbox
                WHERE status='PENDING' AND next_attempt_uptime_ms<=?
                ORDER BY next_attempt_uptime_ms,created_uptime_ms,message_id
                LIMIT ?
                """,
                (now_uptime_ms, limit),
            ).fetchall()
            for message_id, message_type, runtime_session_id, raw, prior_attempts in rows:
                attempt_number = int(prior_attempts) + 1
                next_at = now_uptime_ms + retry_delay_ms(attempt_number)
                self.db.execute(
                    "UPDATE durable_outbox SET attempt_count=?,last_attempt_uptime_ms=?,next_attempt_uptime_ms=? "
                    "WHERE message_id=? AND status='PENDING'",
                    (attempt_number, now_uptime_ms, next_at, message_id),
                )
                attempts.append(
                    DeliveryAttempt(
                        message_id=message_id,
                        message_type=message_type,
                        runtime_session_id=runtime_session_id,
                        canonical_json=bytes(raw),
                        attempt_number=attempt_number,
                        next_attempt_uptime_ms=next_at,
                    )
                )
        return attempts

    def observe_inbound(self, message: dict[str, Any], *, now_uptime_ms: int | None = None) -> bool:
        validate_schema(message, "a620_training_runtime_message.schema.json")
        correlation_id = message["correlationId"]
        if correlation_id is None:
            return False
        now = message["sentAtUptimeMs"] if now_uptime_ms is None else now_uptime_ms
        with self._transaction():
            row = self.db.execute(
                "SELECT runtime_session_id,message_type,obligations_json,observed_json,status "
                "FROM durable_outbox WHERE message_id=?",
                (correlation_id,),
            ).fetchone()
            if row is None:
                return False
            runtime_session_id, outbound_type, obligations_raw, observed_raw, status = row
            if runtime_session_id != message["runtimeSessionId"]:
                raise OutboxConflict("correlated response belongs to a different runtime session")
            if status != "PENDING":
                return False
            obligations = strict_json_loads(bytes(obligations_raw))
            observed = strict_json_loads(bytes(observed_raw))
            response_type = message["messageType"]
            if response_type not in obligations:
                raise OutboxConflict(
                    f"{response_type} is not an obligation for outbound {outbound_type}"
                )
            if response_type == "COMMAND_ACCEPTED" and message["payload"]["acceptedMessageType"] != outbound_type:
                raise OutboxConflict("COMMAND_ACCEPTED acceptedMessageType does not match its outbound command")
            if response_type not in observed:
                observed.append(response_type)
            complete = set(observed) == set(obligations)
            self.db.execute(
                "UPDATE durable_outbox SET observed_json=?,status=?,completed_uptime_ms=? WHERE message_id=?",
                (
                    canonical_bytes(sorted(observed)),
                    "COMPLETED" if complete else "PENDING",
                    now if complete else None,
                    correlation_id,
                ),
            )
            if complete and outbound_type == "RESULT_READY" and response_type == "ACK_RESULT_COMMITTED":
                # Process evidence can be released only after Android confirms
                # the result transaction, never merely after RESULT_READY send.
                self.db.execute(
                    "UPDATE durable_outbox SET status='COMPLETED',completed_uptime_ms=? "
                    "WHERE runtime_session_id=? AND status='PENDING' AND retention_mode='UNTIL_RESULT_COMMIT'",
                    (now, runtime_session_id),
                )
            return complete

    def cancel_runtime(self, runtime_session_id: str, reason: str, *, now_uptime_ms: int) -> int:
        if not reason or len(reason.encode("utf-8")) > 512:
            raise ValueError("cancel reason must be 1..512 UTF-8 bytes")
        with self._transaction():
            cursor = self.db.execute(
                "UPDATE durable_outbox SET status='CANCELLED',completed_uptime_ms=?,cancel_reason=? "
                "WHERE runtime_session_id=? AND status='PENDING'",
                (now_uptime_ms, reason, runtime_session_id),
            )
            return int(cursor.rowcount)

    def pending(self, runtime_session_id: str | None = None) -> list[dict[str, Any]]:
        sql = (
            "SELECT message_id,runtime_session_id,message_type,attempt_count,next_attempt_uptime_ms," 
            "canonical_json FROM durable_outbox WHERE status='PENDING'"
        )
        args: tuple[Any, ...] = ()
        if runtime_session_id is not None:
            sql += " AND runtime_session_id=?"
            args = (runtime_session_id,)
        sql += " ORDER BY created_uptime_ms,message_id"
        return [
            {
                "messageId": row[0],
                "runtimeSessionId": row[1],
                "messageType": row[2],
                "attemptCount": int(row[3]),
                "nextAttemptUptimeMs": int(row[4]),
                "message": strict_json_loads(bytes(row[5])),
            }
            for row in self.db.execute(sql, args).fetchall()
        ]

    def prune_terminal(self, *, before_uptime_ms: int, limit: int = 1000) -> int:
        if before_uptime_ms < 0 or not 1 <= limit <= 10_000:
            raise ValueError("invalid outbox prune arguments")
        with self._transaction():
            rows = self.db.execute(
                "SELECT message_id FROM durable_outbox WHERE status IN ('COMPLETED','CANCELLED') "
                "AND completed_uptime_ms IS NOT NULL AND completed_uptime_ms<? "
                "ORDER BY completed_uptime_ms,message_id LIMIT ?",
                (before_uptime_ms, limit),
            ).fetchall()
            if rows:
                self.db.executemany(
                    "DELETE FROM durable_outbox WHERE message_id=?",
                    [(row[0],) for row in rows],
                )
            return len(rows)

    def integrity_check(self) -> None:
        result = self.db.execute("PRAGMA quick_check").fetchone()
        if result is None or result[0] != "ok":
            raise OutboxConflict(f"SQLite quick_check failed: {result}")
        rows = self.db.execute(
            """
            SELECT message_id,runtime_session_id,sender_role,sender_seq,message_type,
                   canonical_sha256,canonical_json,obligations_json,observed_json,
                   retention_mode,status,created_uptime_ms,attempt_count,
                   last_attempt_uptime_ms,next_attempt_uptime_ms,completed_uptime_ms,cancel_reason
            FROM durable_outbox
            """
        ).fetchall()
        for row in rows:
            (
                message_id, runtime_session_id, sender_role, sender_seq, message_type,
                digest, raw, obligations_raw, observed_raw, retention, status,
                created, attempts, last_attempt, next_attempt, completed, cancel_reason,
            ) = row
            message = strict_json_loads(bytes(raw))
            if canonical_sha256(message) != digest or canonical_bytes(message) != bytes(raw):
                raise OutboxConflict("durable outbox canonical payload integrity mismatch")
            if (
                message["messageId"] != message_id
                or message["runtimeSessionId"] != runtime_session_id
                or message["senderRole"] != sender_role
                or message["senderSeq"] != sender_seq
                or message["messageType"] != message_type
            ):
                raise OutboxConflict("durable outbox indexed metadata differs from canonical message")
            obligations = strict_json_loads(bytes(obligations_raw))
            observed = strict_json_loads(bytes(observed_raw))
            expected_obligations = list(RESPONSE_OBLIGATIONS.get(message_type, ()))
            expected_retention = "UNTIL_RESPONSES" if expected_obligations else "UNTIL_RESULT_COMMIT"
            if obligations != expected_obligations or retention != expected_retention:
                raise OutboxConflict("durable outbox policy projection mismatch")
            if len(observed) != len(set(observed)) or not set(observed).issubset(set(obligations)):
                raise OutboxConflict("durable outbox observed obligations are malformed")
            if int(attempts) < 0 or int(created) < 0 or int(next_attempt) < int(created):
                raise OutboxConflict("durable outbox retry metadata is malformed")
            if (int(attempts) == 0) != (last_attempt is None):
                raise OutboxConflict("durable outbox last-attempt metadata is inconsistent")
            if status == "PENDING" and obligations and set(observed) == set(obligations):
                raise OutboxConflict("durable outbox completed obligations remain pending")
            if status in {"COMPLETED", "CANCELLED"} and completed is None:
                raise OutboxConflict("durable outbox terminal row lacks completion time")
            if status == "CANCELLED" and not cancel_reason:
                raise OutboxConflict("durable outbox cancelled row lacks a reason")

