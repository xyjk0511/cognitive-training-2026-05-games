from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import InstallBusy, InvalidState, ReleaseRollback, StaleFence
from .sqlite_support import canonical_json_bytes, connect, immediate_transaction, load_blob, sha256_bytes
from .package_storage import (
    guard_package_clock,
    migrate_package_schema,
    validate_package_integrity,
    verified_manifest,
)

@dataclass(frozen=True)
class InstallLease:
    game_code: str
    owner_id: str
    fence_token: int
    lease_until_ms: int

@dataclass(frozen=True)
class InstallPlan:
    install_id: str
    game_code: str
    inactive_slot: str
    release_sequence: int
    candidate_sha256: str
    fence_token: int
    staging_path: str

class PackageInstallCoordinator:
    """Per-game lease/fencing and atomic activation reference.

    Files are staged under an install-id-specific directory. The database
    activation pointer, durable release floor, and COMMITTED journal phase
    are updated in one SQLite transaction. A stale installer cannot commit.
    """

    def __init__(self, db_path: str | Path, monotonic_epoch_id: str = "legacy-epoch"):
        self.db_path = str(db_path)
        self.monotonic_epoch_id = monotonic_epoch_id
        conn = connect(self.db_path)
        try:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS package_install_lock (
                game_code TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                fence_token INTEGER NOT NULL CHECK(fence_token>=1),
                lease_until_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS package_active (
                game_code TEXT PRIMARY KEY,
                active_slot TEXT NOT NULL CHECK(active_slot IN ('slot-a','slot-b')),
                package_sha256 TEXT NOT NULL,
                release_sequence INTEGER NOT NULL CHECK(release_sequence>=0),
                manifest_json BLOB NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS package_release_floor (
                game_code TEXT PRIMARY KEY,
                minimum_release_sequence INTEGER NOT NULL CHECK(minimum_release_sequence>=0),
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS package_install_journal (
                install_id TEXT PRIMARY KEY,
                game_code TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                fence_token INTEGER NOT NULL,
                inactive_slot TEXT NOT NULL CHECK(inactive_slot IN ('slot-a','slot-b')),
                candidate_sha256 TEXT NOT NULL,
                release_sequence INTEGER NOT NULL,
                phase TEXT NOT NULL CHECK(phase IN ('STAGING','STAGED','VERIFIED','COMMITTED','ABORTED')),
                staging_path TEXT NOT NULL,
                manifest_json BLOB,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                UNIQUE(game_code, candidate_sha256, release_sequence)
            );
            """)
            with immediate_transaction(conn):
                migrate_package_schema(conn, self.monotonic_epoch_id)
            validate_package_integrity(conn)
        finally:
            conn.close()

    def _conn(self):
        return connect(self.db_path)

    def acquire_lock(
        self, *, game_code: str, owner_id: str, now_ms: int,
        lease_ms: int = 30000,
    ) -> InstallLease:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                guard_package_clock(conn, self.monotonic_epoch_id, now_ms)
                row = conn.execute("SELECT * FROM package_install_lock WHERE game_code=?",
                                   (game_code,)).fetchone()
                until = now_ms + lease_ms
                if row is None:
                    fence = 1
                    conn.execute("INSERT INTO package_install_lock VALUES (?,?,?,?,?)",
                                 (game_code, owner_id, fence, until, now_ms))
                elif row['owner_id'] == owner_id and row['lease_until_ms'] > now_ms:
                    fence = row['fence_token']
                    conn.execute("UPDATE package_install_lock SET lease_until_ms=?,updated_at_ms=? WHERE game_code=?",
                                 (until, now_ms, game_code))
                elif row['lease_until_ms'] <= now_ms:
                    fence = row['fence_token'] + 1
                    conn.execute("UPDATE package_install_lock SET owner_id=?,fence_token=?,lease_until_ms=?,updated_at_ms=? WHERE game_code=?",
                                 (owner_id, fence, until, now_ms, game_code))
                else:
                    raise InstallBusy(f"install lock held by {row['owner_id']}")
                return InstallLease(game_code, owner_id, fence, until)
        finally:
            conn.close()

    def begin_install(
        self, *, game_code: str, owner_id: str, fence_token: int,
        candidate_sha256: str, release_sequence: int,
        staging_root: str, now_ms: int,
        install_id: str | None = None,
    ) -> InstallPlan:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                guard_package_clock(conn, self.monotonic_epoch_id, now_ms)
                self._assert_lock(conn, game_code, owner_id, fence_token, now_ms)
                active = conn.execute("SELECT * FROM package_active WHERE game_code=?", (game_code,)).fetchone()
                floor = conn.execute("SELECT minimum_release_sequence FROM package_release_floor WHERE game_code=?",
                                     (game_code,)).fetchone()
                min_seq = floor['minimum_release_sequence'] if floor else -1
                if active and active['package_sha256'] == candidate_sha256 and active['release_sequence'] == release_sequence:
                    raise InvalidState("candidate is already the active package")
                if release_sequence <= min_seq:
                    raise ReleaseRollback("release sequence does not exceed durable floor")
                inactive = 'slot-b' if active and active['active_slot'] == 'slot-a' else 'slot-a'
                iid = install_id or str(uuid.uuid4())
                staging_path = str(Path(staging_root) / game_code / iid)
                existing = conn.execute("SELECT * FROM package_install_journal WHERE install_id=?", (iid,)).fetchone()
                if existing:
                    expected = (game_code, owner_id, fence_token, candidate_sha256, release_sequence)
                    actual = (existing['game_code'], existing['owner_id'], existing['fence_token'],
                              existing['candidate_sha256'], existing['release_sequence'])
                    if actual != expected:
                        raise InvalidState("installId reused with different identity")
                    return InstallPlan(iid, game_code, existing['inactive_slot'], release_sequence,
                                       candidate_sha256, fence_token, existing['staging_path'])
                conn.execute("""
                    INSERT INTO package_install_journal(
                        install_id,game_code,owner_id,fence_token,inactive_slot,candidate_sha256,
                        release_sequence,phase,staging_path,manifest_json,created_at_ms,updated_at_ms,
                        manifest_sha256,abort_reason
                    ) VALUES (?,?,?,?,?,?,?,'STAGING',?,NULL,?,?,NULL,NULL)
                """, (iid, game_code, owner_id, fence_token, inactive,
                       candidate_sha256, release_sequence, staging_path, now_ms, now_ms))
                return InstallPlan(iid, game_code, inactive, release_sequence,
                                   candidate_sha256, fence_token, staging_path)
        finally:
            conn.close()

    def mark_staged(self, *, install_id: str, owner_id: str, fence_token: int, now_ms: int) -> None:
        self._advance(install_id, owner_id, fence_token, now_ms, 'STAGING', 'STAGED', None)

    def mark_verified(
        self, *, install_id: str, owner_id: str, fence_token: int,
        manifest: dict[str, Any], now_ms: int,
    ) -> None:
        self._advance(install_id, owner_id, fence_token, now_ms, 'STAGED', 'VERIFIED', manifest)

    def _advance(
        self, install_id: str, owner_id: str, fence_token: int,
        now_ms: int, expected: str, target: str,
        manifest: dict[str, Any] | None,
    ) -> None:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                guard_package_clock(conn, self.monotonic_epoch_id, now_ms)
                row = self._journal(conn, install_id)
                self._assert_lock(conn, row['game_code'], owner_id, fence_token, now_ms)
                if row['owner_id'] != owner_id or row['fence_token'] != fence_token:
                    raise StaleFence("journal belongs to an older install fence")
                if row['phase'] == target:
                    return
                if row['phase'] != expected:
                    raise InvalidState(f"expected {expected}, got {row['phase']}")
                manifest_blob = canonical_json_bytes(manifest) if manifest is not None else None
                manifest_hash = sha256_bytes(manifest_blob) if manifest_blob is not None else None
                conn.execute(
                    "UPDATE package_install_journal SET phase=?,"
                    "manifest_json=COALESCE(?,manifest_json),"
                    "manifest_sha256=COALESCE(?,manifest_sha256),updated_at_ms=? WHERE install_id=?",
                    (target, manifest_blob, manifest_hash, now_ms, install_id),
                )
        finally:
            conn.close()

    def commit_activation(
        self, *, install_id: str, owner_id: str, fence_token: int,
        now_ms: int, fault_at: str | None = None,
    ) -> dict[str, Any]:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                guard_package_clock(conn, self.monotonic_epoch_id, now_ms)
                row = self._journal(conn, install_id)
                self._assert_lock(conn, row['game_code'], owner_id, fence_token, now_ms)
                if row['owner_id'] != owner_id or row['fence_token'] != fence_token:
                    raise StaleFence("stale installer cannot activate")
                if row['phase'] == 'COMMITTED':
                    return self._active_dict(conn, row['game_code'])
                if row['phase'] != 'VERIFIED' or row['manifest_json'] is None:
                    raise InvalidState("package must be VERIFIED before activation")
                floor = conn.execute("SELECT minimum_release_sequence FROM package_release_floor WHERE game_code=?",
                                     (row['game_code'],)).fetchone()
                min_seq = floor['minimum_release_sequence'] if floor else -1
                if row['release_sequence'] <= min_seq:
                    raise ReleaseRollback("candidate no longer exceeds durable floor")
                verified_manifest(
                    row['manifest_json'], row['manifest_sha256'],
                    label=f"install manifest {install_id}",
                )
                conn.execute("""
                    INSERT INTO package_active(
                        game_code,active_slot,package_sha256,release_sequence,manifest_json,
                        updated_at_ms,manifest_sha256
                    ) VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(game_code) DO UPDATE SET
                        active_slot=excluded.active_slot,
                        package_sha256=excluded.package_sha256,
                        release_sequence=excluded.release_sequence,
                        manifest_json=excluded.manifest_json,
                        manifest_sha256=excluded.manifest_sha256,
                        updated_at_ms=excluded.updated_at_ms
                """, (row['game_code'], row['inactive_slot'], row['candidate_sha256'],
                       row['release_sequence'], row['manifest_json'], now_ms, row['manifest_sha256']))
                if fault_at == 'after_active_pointer':
                    raise RuntimeError('fault injection: after_active_pointer')
                conn.execute("""
                    INSERT INTO package_release_floor VALUES (?,?,?)
                    ON CONFLICT(game_code) DO UPDATE SET
                        minimum_release_sequence=excluded.minimum_release_sequence,
                        updated_at_ms=excluded.updated_at_ms
                """, (row['game_code'], row['release_sequence'], now_ms))
                if fault_at == 'after_release_floor':
                    raise RuntimeError('fault injection: after_release_floor')
                conn.execute("UPDATE package_install_journal SET phase='COMMITTED',updated_at_ms=? WHERE install_id=?",
                             (now_ms, install_id))
                if fault_at == 'before_commit':
                    raise RuntimeError('fault injection: before_commit')
                return self._active_dict(conn, row['game_code'])
        finally:
            conn.close()

    def recover_abandoned(
        self, *, game_code: str, owner_id: str, fence_token: int, now_ms: int,
    ) -> list[str]:
        conn = self._conn()
        try:
            with immediate_transaction(conn):
                guard_package_clock(conn, self.monotonic_epoch_id, now_ms)
                self._assert_lock(conn, game_code, owner_id, fence_token, now_ms)
                rows = conn.execute("""
                    SELECT install_id,staging_path FROM package_install_journal
                    WHERE game_code=? AND phase IN ('STAGING','STAGED','VERIFIED')
                      AND fence_token<?
                """, (game_code, fence_token)).fetchall()
                for row in rows:
                    conn.execute(
                        "UPDATE package_install_journal SET phase='ABORTED',"
                        "abort_reason='SUPERSEDED_INSTALL_FENCE',updated_at_ms=? WHERE install_id=?",
                        (now_ms, row['install_id']),
                    )
                return [row['staging_path'] for row in rows]
        finally:
            conn.close()

    def active(self, game_code: str) -> dict[str, Any] | None:
        conn = self._conn()
        try:
            row = conn.execute("SELECT * FROM package_active WHERE game_code=?", (game_code,)).fetchone()
            if not row:
                return None
            result = dict(row)
            result['manifest'] = verified_manifest(
                result.pop('manifest_json'), result['manifest_sha256'],
                label=f"active manifest {game_code}",
            )
            return result
        finally:
            conn.close()

    def journal(self, install_id: str) -> dict[str, Any]:
        conn = self._conn()
        try:
            result = dict(self._journal(conn, install_id))
            if result['manifest_json'] is not None:
                result['manifest'] = verified_manifest(
                    result['manifest_json'], result['manifest_sha256'],
                    label=f"install manifest {install_id}",
                )
            return result
        finally:
            conn.close()

    def validate_integrity(self) -> dict[str, int | str]:
        conn = self._conn()
        try:
            return validate_package_integrity(conn)
        finally:
            conn.close()

    def quick_check(self) -> str:
        conn = self._conn()
        try:
            return conn.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            conn.close()

    @staticmethod
    def _journal(conn: sqlite3.Connection, install_id: str) -> sqlite3.Row:
        row = conn.execute("SELECT * FROM package_install_journal WHERE install_id=?", (install_id,)).fetchone()
        if not row:
            raise InvalidState("unknown installId")
        return row

    @staticmethod
    def _assert_lock(
        conn: sqlite3.Connection, game_code: str, owner_id: str,
        fence_token: int, now_ms: int,
    ) -> None:
        row = conn.execute("SELECT * FROM package_install_lock WHERE game_code=?", (game_code,)).fetchone()
        if (not row or row['owner_id'] != owner_id or row['fence_token'] != fence_token or
            row['lease_until_ms'] <= now_ms):
            raise StaleFence("install lock owner/fence/expiry mismatch")

    @staticmethod
    def _active_dict(conn: sqlite3.Connection, game_code: str) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM package_active WHERE game_code=?", (game_code,)).fetchone()
        if not row:
            raise InvalidState("active package missing after commit")
        result = dict(row)
        result['manifest'] = verified_manifest(
            result.pop('manifest_json'), result['manifest_sha256'],
            label=f"active manifest {game_code}",
        )
        return result
