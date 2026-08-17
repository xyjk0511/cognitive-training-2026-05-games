from __future__ import annotations

import sqlite3
from typing import Any

from .errors import ClockRollback, PersistedDataCorruption, SchemaMigrationRequired
from .sqlite_support import SAFE_INTEGER, canonical_json_bytes, load_blob, sha256_bytes

from .generated_storage_profiles import (
    PACKAGE_SCHEMA_VERSION,
    PACKAGE_STORAGE_PROFILE,
)


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_column(conn: sqlite3.Connection, table: str, declaration: str) -> None:
    if declaration.split()[0] not in _columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {declaration}")


def _meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM package_coordination_meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def _set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO package_coordination_meta(key,value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def migrate_package_schema(conn: sqlite3.Connection, monotonic_epoch_id: str) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS package_coordination_meta ("
        "key TEXT PRIMARY KEY,value TEXT NOT NULL)"
    )
    existing_version = _meta(conn, "packageSchemaVersion")
    if existing_version is not None:
        try:
            version = int(existing_version)
        except ValueError as exc:
            raise SchemaMigrationRequired("invalid package schema version") from exc
        if version > PACKAGE_SCHEMA_VERSION:
            raise SchemaMigrationRequired("package database is newer than this implementation")

    _add_column(conn, "package_active", "manifest_sha256 TEXT")
    _add_column(conn, "package_install_journal", "manifest_sha256 TEXT")
    _add_column(conn, "package_install_journal", "abort_reason TEXT")

    for row in conn.execute(
        "SELECT game_code,manifest_json,manifest_sha256 FROM package_active"
    ).fetchall():
        manifest = load_blob(row["manifest_json"], label=f"active manifest {row['game_code']}")
        digest = sha256_bytes(canonical_json_bytes(manifest))
        if row["manifest_sha256"] not in (None, digest):
            raise PersistedDataCorruption(f"active manifest hash mismatch for {row['game_code']}")
        conn.execute(
            "UPDATE package_active SET manifest_sha256=? WHERE game_code=?",
            (digest, row["game_code"]),
        )

    for row in conn.execute(
        "SELECT install_id,manifest_json,manifest_sha256 FROM package_install_journal "
        "WHERE manifest_json IS NOT NULL"
    ).fetchall():
        manifest = load_blob(row["manifest_json"], label=f"install manifest {row['install_id']}")
        digest = sha256_bytes(canonical_json_bytes(manifest))
        if row["manifest_sha256"] not in (None, digest):
            raise PersistedDataCorruption(f"install manifest hash mismatch for {row['install_id']}")
        conn.execute(
            "UPDATE package_install_journal SET manifest_sha256=? WHERE install_id=?",
            (digest, row["install_id"]),
        )

    stored_epoch = _meta(conn, "packageMonotonicEpochId")
    if stored_epoch is None:
        _set_meta(conn, "packageMonotonicEpochId", monotonic_epoch_id)
        _set_meta(conn, "packageLastObservedUptimeMs", "0")
    elif stored_epoch != monotonic_epoch_id:
        # A lease timestamp from a previous boot cannot be compared to the new
        # uptime domain.  Conservatively abort noncommitted installs and clear
        # all locks; committed activation remains authoritative.
        conn.execute("DELETE FROM package_install_lock")
        conn.execute(
            "UPDATE package_install_journal SET phase='ABORTED',"
            "abort_reason='MONOTONIC_EPOCH_CHANGED' "
            "WHERE phase IN ('STAGING','STAGED','VERIFIED')"
        )
        _set_meta(conn, "packageMonotonicEpochId", monotonic_epoch_id)
        _set_meta(conn, "packageLastObservedUptimeMs", "0")

    _set_meta(conn, "packageStorageProfile", PACKAGE_STORAGE_PROFILE)
    _set_meta(conn, "packageSchemaVersion", str(PACKAGE_SCHEMA_VERSION))


def guard_package_clock(conn: sqlite3.Connection, monotonic_epoch_id: str, now_ms: int) -> None:
    if not isinstance(now_ms, int) or isinstance(now_ms, bool) or not 0 <= now_ms <= SAFE_INTEGER:
        raise ClockRollback("package uptime must be a non-negative safe integer")
    stored_epoch = _meta(conn, "packageMonotonicEpochId")
    if stored_epoch != monotonic_epoch_id:
        raise ClockRollback("package monotonic epoch changed without reopening coordinator")
    raw = _meta(conn, "packageLastObservedUptimeMs")
    if raw is None:
        raise PersistedDataCorruption("package clock watermark missing")
    try:
        previous = int(raw)
    except ValueError as exc:
        raise PersistedDataCorruption("package clock watermark is invalid") from exc
    if now_ms < previous:
        raise ClockRollback(f"package clock moved backwards: {now_ms} < {previous}")
    _set_meta(conn, "packageLastObservedUptimeMs", str(now_ms))


def verified_manifest(blob: bytes | str, digest: str, *, label: str) -> dict[str, Any]:
    value = load_blob(blob, expected_sha256=digest, label=label)
    if not isinstance(value, dict):
        raise PersistedDataCorruption(f"{label} must be an object")
    return value


def validate_package_integrity(conn: sqlite3.Connection) -> dict[str, int | str]:
    quick = conn.execute("PRAGMA quick_check").fetchone()[0]
    if quick != "ok":
        raise PersistedDataCorruption(f"SQLite quick_check failed: {quick}")
    if conn.execute("PRAGMA foreign_key_check").fetchall():
        raise PersistedDataCorruption("package foreign key check failed")
    if _meta(conn, "packageStorageProfile") != PACKAGE_STORAGE_PROFILE:
        raise PersistedDataCorruption("package storage profile mismatch")
    if _meta(conn, "packageSchemaVersion") != str(PACKAGE_SCHEMA_VERSION):
        raise PersistedDataCorruption("package schema version mismatch")

    active_rows = conn.execute("SELECT * FROM package_active ORDER BY game_code").fetchall()
    for row in active_rows:
        verified_manifest(
            row["manifest_json"], row["manifest_sha256"],
            label=f"active manifest {row['game_code']}",
        )
        floor = conn.execute(
            "SELECT minimum_release_sequence FROM package_release_floor WHERE game_code=?",
            (row["game_code"],),
        ).fetchone()
        if not floor or floor["minimum_release_sequence"] != row["release_sequence"]:
            raise PersistedDataCorruption(f"active pointer and release floor differ for {row['game_code']}")

    journal_rows = conn.execute("SELECT * FROM package_install_journal ORDER BY install_id").fetchall()
    for row in journal_rows:
        if row["phase"] in {"VERIFIED", "COMMITTED"}:
            if row["manifest_json"] is None or row["manifest_sha256"] is None:
                raise PersistedDataCorruption("verified install has no manifest evidence")
            verified_manifest(
                row["manifest_json"], row["manifest_sha256"],
                label=f"install manifest {row['install_id']}",
            )
        if row["phase"] == "ABORTED" and not row["abort_reason"]:
            raise PersistedDataCorruption("aborted install has no reason")
        if row["phase"] == "COMMITTED":
            floor = conn.execute(
                "SELECT minimum_release_sequence FROM package_release_floor WHERE game_code=?",
                (row["game_code"],),
            ).fetchone()
            if not floor or row["release_sequence"] > floor["minimum_release_sequence"]:
                raise PersistedDataCorruption("committed install exceeds durable floor")

    # Locks may exist only for the current epoch; migration clears old-domain locks.
    if _meta(conn, "packageMonotonicEpochId") is None:
        raise PersistedDataCorruption("package monotonic epoch is missing")

    return {
        "profile": PACKAGE_STORAGE_PROFILE,
        "schemaVersion": PACKAGE_SCHEMA_VERSION,
        "activePackageCount": len(active_rows),
        "installJournalCount": len(journal_rows),
    }
