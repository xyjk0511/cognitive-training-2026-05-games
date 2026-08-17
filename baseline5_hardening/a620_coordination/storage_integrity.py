from __future__ import annotations

import sqlite3
from typing import Any

from .errors import ClockRollback, PersistedDataCorruption, SchemaMigrationRequired
from .sqlite_support import (
    SAFE_INTEGER,
    canonical_json_bytes,
    load_blob,
    sha256_bytes,
)

from .generated_storage_profiles import (
    RUNTIME_SCHEMA_VERSION,
    RUNTIME_STORAGE_PROFILE,
    RUNTIME_WATCHDOG_SENTINEL,
)


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_column(conn: sqlite3.Connection, table: str, declaration: str) -> None:
    name = declaration.split()[0]
    if name not in _columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {declaration}")


def _meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM coordination_meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def _set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO coordination_meta(key,value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def migrate_runtime_schema(conn: sqlite3.Connection) -> None:
    """Perform the only supported baseline.5 -> baseline.6 storage migration.

    The migration backfills integrity hashes before it records the new schema
    version.  Any future/unknown version is rejected rather than guessed.
    """

    conn.execute(
        "CREATE TABLE IF NOT EXISTS coordination_meta ("
        "key TEXT PRIMARY KEY,value TEXT NOT NULL)"
    )
    existing = _meta(conn, "runtimeSchemaVersion")
    if existing is not None:
        try:
            version = int(existing)
        except ValueError as exc:
            raise SchemaMigrationRequired("invalid runtime schema version metadata") from exc
        if version > RUNTIME_SCHEMA_VERSION:
            raise SchemaMigrationRequired(
                f"runtime database schema {version} is newer than supported {RUNTIME_SCHEMA_VERSION}"
            )
        if version < 1:
            raise SchemaMigrationRequired(f"unsupported runtime schema version {version}")

    _add_column(conn, "runtime_session", "initial_snapshot_sha256 TEXT")
    _add_column(conn, "runtime_session", "last_observed_uptime_ms INTEGER")
    _add_column(conn, "inbox_message", "outcome_sha256 TEXT")
    _add_column(conn, "outbox_message", "required_acks_sha256 TEXT")
    _add_column(conn, "outbox_message", "received_acks_sha256 TEXT")
    _add_column(conn, "watchdog_obligation", "details_sha256 TEXT")
    _add_column(conn, "watchdog_obligation", "source_message_key TEXT")

    # Backfill canonical hashes from the bytes actually persisted.  Parsing is
    # strict; non-canonical legacy bytes are rejected instead of normalized in
    # place, preserving evidence of corruption.
    for row in conn.execute(
        "SELECT runtime_session_id,snapshot_json,snapshot_sha256,updated_at_ms "
        "FROM runtime_snapshot"
    ).fetchall():
        load_blob(
            row["snapshot_json"],
            expected_sha256=row["snapshot_sha256"],
            label=f"runtime snapshot {row['runtime_session_id']}",
        )
        conn.execute(
            "UPDATE runtime_session SET "
            "initial_snapshot_sha256=COALESCE(initial_snapshot_sha256,?),"
            "last_observed_uptime_ms=COALESCE(last_observed_uptime_ms,updated_at_ms) "
            "WHERE runtime_session_id=?",
            (row["snapshot_sha256"], row["runtime_session_id"]),
        )

    for row in conn.execute(
        "SELECT message_id,outcome_json,outcome_sha256 FROM inbox_message"
    ).fetchall():
        obj = load_blob(row["outcome_json"], label=f"inbox outcome {row['message_id']}")
        digest = sha256_bytes(canonical_json_bytes(obj))
        if row["outcome_sha256"] not in (None, digest):
            raise PersistedDataCorruption(f"inbox outcome hash mismatch for {row['message_id']}")
        conn.execute(
            "UPDATE inbox_message SET outcome_sha256=? WHERE message_id=?",
            (digest, row["message_id"]),
        )

    for row in conn.execute(
        "SELECT message_id,required_acks_json,received_acks_json,"
        "required_acks_sha256,received_acks_sha256 FROM outbox_message"
    ).fetchall():
        required = load_blob(row["required_acks_json"], label=f"outbox required ACKs {row['message_id']}")
        received = load_blob(row["received_acks_json"], label=f"outbox received ACKs {row['message_id']}")
        req_hash = sha256_bytes(canonical_json_bytes(required))
        rec_hash = sha256_bytes(canonical_json_bytes(received))
        if row["required_acks_sha256"] not in (None, req_hash):
            raise PersistedDataCorruption(f"required ACK hash mismatch for {row['message_id']}")
        if row["received_acks_sha256"] not in (None, rec_hash):
            raise PersistedDataCorruption(f"received ACK hash mismatch for {row['message_id']}")
        conn.execute(
            "UPDATE outbox_message SET required_acks_sha256=?,received_acks_sha256=? "
            "WHERE message_id=?",
            (req_hash, rec_hash, row["message_id"]),
        )

    for row in conn.execute(
        "SELECT obligation_id,source_message_id,source_message_key,details_json,details_sha256 "
        "FROM watchdog_obligation"
    ).fetchall():
        details = load_blob(row["details_json"], label=f"watchdog details {row['obligation_id']}")
        digest = sha256_bytes(canonical_json_bytes(details))
        key = row["source_message_id"] or RUNTIME_WATCHDOG_SENTINEL
        if row["source_message_key"] not in (None, key):
            raise PersistedDataCorruption(
                f"watchdog source key mismatch for {row['obligation_id']}"
            )
        if row["details_sha256"] not in (None, digest):
            raise PersistedDataCorruption(f"watchdog details hash mismatch for {row['obligation_id']}")
        conn.execute(
            "UPDATE watchdog_obligation SET source_message_key=?,details_sha256=? "
            "WHERE obligation_id=?",
            (key, digest, row["obligation_id"]),
        )

    duplicates = conn.execute(
        "SELECT runtime_session_id,kind,source_message_key,COUNT(*) AS n "
        "FROM watchdog_obligation GROUP BY runtime_session_id,kind,source_message_key "
        "HAVING COUNT(*)>1"
    ).fetchall()
    if duplicates:
        raise PersistedDataCorruption("duplicate watchdog obligation identity found during migration")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS watchdog_identity_v2_idx "
        "ON watchdog_obligation(runtime_session_id,kind,source_message_key)"
    )

    missing = conn.execute(
        "SELECT runtime_session_id FROM runtime_session WHERE "
        "initial_snapshot_sha256 IS NULL OR last_observed_uptime_ms IS NULL LIMIT 1"
    ).fetchone()
    if missing:
        raise PersistedDataCorruption(
            f"runtime metadata backfill incomplete for {missing['runtime_session_id']}"
        )

    _set_meta(conn, "runtimeStorageProfile", RUNTIME_STORAGE_PROFILE)
    _set_meta(conn, "runtimeSchemaVersion", str(RUNTIME_SCHEMA_VERSION))


def guard_runtime_clock(
    conn: sqlite3.Connection,
    runtime_session_id: str,
    now_ms: int,
) -> None:
    if not isinstance(now_ms, int) or isinstance(now_ms, bool) or not 0 <= now_ms <= SAFE_INTEGER:
        raise ClockRollback("uptime must be a non-negative JavaScript-safe integer")
    row = conn.execute(
        "SELECT last_observed_uptime_ms FROM runtime_session WHERE runtime_session_id=?",
        (runtime_session_id,),
    ).fetchone()
    if not row:
        return
    previous = row["last_observed_uptime_ms"]
    if previous is None:
        raise PersistedDataCorruption("runtime clock watermark is missing")
    if now_ms < previous:
        raise ClockRollback(
            f"runtime clock moved backwards for {runtime_session_id}: {now_ms} < {previous}"
        )
    conn.execute(
        "UPDATE runtime_session SET last_observed_uptime_ms=?,updated_at_ms=MAX(updated_at_ms,?) "
        "WHERE runtime_session_id=?",
        (now_ms, now_ms, runtime_session_id),
    )


def guard_all_active_runtime_clocks(conn: sqlite3.Connection, now_ms: int) -> None:
    rows = conn.execute(
        "SELECT runtime_session_id FROM runtime_session WHERE lifecycle='ACTIVE'"
    ).fetchall()
    for row in rows:
        guard_runtime_clock(conn, row["runtime_session_id"], now_ms)


def read_verified_snapshot(conn: sqlite3.Connection, runtime_session_id: str) -> tuple[sqlite3.Row, Any]:
    row = conn.execute(
        "SELECT * FROM runtime_snapshot WHERE runtime_session_id=?",
        (runtime_session_id,),
    ).fetchone()
    if not row:
        raise PersistedDataCorruption(f"snapshot missing for {runtime_session_id}")
    obj = load_blob(
        row["snapshot_json"],
        expected_sha256=row["snapshot_sha256"],
        label=f"runtime snapshot {runtime_session_id}",
    )
    return row, obj


def validate_runtime_integrity(conn: sqlite3.Connection) -> dict[str, int | str]:
    quick = conn.execute("PRAGMA quick_check").fetchone()[0]
    if quick != "ok":
        raise PersistedDataCorruption(f"SQLite quick_check failed: {quick}")
    fk_rows = conn.execute("PRAGMA foreign_key_check").fetchall()
    if fk_rows:
        raise PersistedDataCorruption(f"SQLite foreign_key_check failed: {len(fk_rows)} rows")

    if _meta(conn, "runtimeStorageProfile") != RUNTIME_STORAGE_PROFILE:
        raise PersistedDataCorruption("runtime storage profile metadata mismatch")
    if _meta(conn, "runtimeSchemaVersion") != str(RUNTIME_SCHEMA_VERSION):
        raise PersistedDataCorruption("runtime schema version metadata mismatch")

    runtime_count = 0
    for runtime in conn.execute("SELECT * FROM runtime_session ORDER BY runtime_session_id").fetchall():
        runtime_count += 1
        snap, _ = read_verified_snapshot(conn, runtime["runtime_session_id"])
        if snap["revision"] != runtime["state_revision"]:
            raise PersistedDataCorruption(
                f"state revision mismatch for {runtime['runtime_session_id']}"
            )
        if runtime["initial_snapshot_sha256"] is None:
            raise PersistedDataCorruption("initial snapshot hash missing")
        if runtime["last_observed_uptime_ms"] is None:
            raise PersistedDataCorruption("clock watermark missing")
        outcome = conn.execute(
            "SELECT * FROM execution_outcome WHERE runtime_session_id=?",
            (runtime["runtime_session_id"],),
        ).fetchone()
        lease = conn.execute(
            "SELECT * FROM runtime_lease WHERE runtime_session_id=?",
            (runtime["runtime_session_id"],),
        ).fetchone()
        active_wd = conn.execute(
            "SELECT COUNT(*) AS n FROM watchdog_obligation WHERE runtime_session_id=? AND status='ACTIVE'",
            (runtime["runtime_session_id"],),
        ).fetchone()["n"]
        live_outbox = conn.execute(
            "SELECT COUNT(*) AS n FROM outbox_message WHERE runtime_session_id=? AND status IN ('PENDING','IN_FLIGHT')",
            (runtime["runtime_session_id"],),
        ).fetchone()["n"]
        if runtime["lifecycle"] == "ACTIVE":
            if outcome is not None:
                raise PersistedDataCorruption("active runtime has execution outcome")
        else:
            if outcome is None:
                raise PersistedDataCorruption("terminal runtime has no execution outcome")
            if lease is not None or active_wd or live_outbox:
                raise PersistedDataCorruption("terminal runtime retains active work")

    inbox_count = 0
    for row in conn.execute("SELECT * FROM inbox_message ORDER BY message_id").fetchall():
        inbox_count += 1
        load_blob(
            row["outcome_json"],
            expected_sha256=row["outcome_sha256"],
            label=f"inbox outcome {row['message_id']}",
        )

    outbox_count = 0
    for row in conn.execute("SELECT * FROM outbox_message ORDER BY message_id").fetchall():
        outbox_count += 1
        if sha256_bytes(row["canonical_bytes"]) != row["canonical_sha256"]:
            raise PersistedDataCorruption(f"outbox canonical hash mismatch for {row['message_id']}")
        # Also parse the bytes: a matching hash alone does not prove valid JSON.
        load_blob(row["canonical_bytes"], label=f"outbox message {row['message_id']}")
        required = load_blob(
            row["required_acks_json"],
            expected_sha256=row["required_acks_sha256"],
            label=f"required ACKs {row['message_id']}",
        )
        received = load_blob(
            row["received_acks_json"],
            expected_sha256=row["received_acks_sha256"],
            label=f"received ACKs {row['message_id']}",
        )
        if not isinstance(required, list) or not isinstance(received, list):
            raise PersistedDataCorruption("ACK sets must be arrays")
        if required != sorted(set(required)) or received != sorted(set(received)):
            raise PersistedDataCorruption("ACK arrays must be sorted unique sets")
        if not set(received).issubset(required):
            raise PersistedDataCorruption("received ACK is not required")
        complete = set(required).issubset(received)
        if row["status"] == "ACKED" and not complete:
            raise PersistedDataCorruption("ACKED outbox has unsatisfied obligations")
        if row["status"] == "IN_FLIGHT" and (
            row["claim_owner"] is None or row["claim_until_ms"] is None
        ):
            raise PersistedDataCorruption("IN_FLIGHT outbox has no active claim")
        if row["status"] != "IN_FLIGHT" and (
            row["claim_owner"] is not None or row["claim_until_ms"] is not None
        ):
            raise PersistedDataCorruption("non-IN_FLIGHT outbox retains claim fields")

    watchdog_count = 0
    for row in conn.execute("SELECT * FROM watchdog_obligation ORDER BY obligation_id").fetchall():
        watchdog_count += 1
        expected_key = row["source_message_id"] or RUNTIME_WATCHDOG_SENTINEL
        if row["source_message_key"] != expected_key:
            raise PersistedDataCorruption("watchdog normalized source key mismatch")
        load_blob(
            row["details_json"],
            expected_sha256=row["details_sha256"],
            label=f"watchdog details {row['obligation_id']}",
        )

    return {
        "profile": RUNTIME_STORAGE_PROFILE,
        "schemaVersion": RUNTIME_SCHEMA_VERSION,
        "runtimeCount": runtime_count,
        "inboxCount": inbox_count,
        "outboxCount": outbox_count,
        "watchdogCount": watchdog_count,
    }
