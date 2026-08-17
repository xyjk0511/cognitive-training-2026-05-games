from __future__ import annotations

import contextlib
import hashlib
import sqlite3
from pathlib import Path
from typing import Any, Iterator

from a620_gate0.canonical import (
    CanonicalJsonError,
    canonical_bytes as _canonical_bytes,
    canonical_sha256 as _canonical_sha256,
    strict_json_loads,
    validate_json_resources,
)

from .errors import PersistedDataCorruption

SAFE_INTEGER = 9_007_199_254_740_991


def canonical_json_bytes(value: Any) -> bytes:
    """Use the same A620-JCS-1 implementation as the Gate 0 wire layer."""

    return _canonical_bytes(value)


def canonical_sha256(value: Any) -> str:
    return _canonical_sha256(value)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def validate_sha256_hex(value: str, *, label: str = "sha256") -> None:
    if len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value):
        raise ValueError(f"{label} must be 64 lowercase hexadecimal characters")


def connect(path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(
        str(path),
        timeout=5.0,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA wal_autocheckpoint=1000")
    conn.execute("PRAGMA trusted_schema=OFF")
    return conn


@contextlib.contextmanager
def immediate_transaction(conn: sqlite3.Connection) -> Iterator[None]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def json_blob(value: Any) -> bytes:
    return canonical_json_bytes(value)


def verified_json_blob(
    value: bytes | str | None,
    *,
    expected_sha256: str | None = None,
    label: str = "persisted JSON",
    default: Any = None,
    require_canonical: bool = True,
) -> Any:
    """Decode stored JSON and verify bytes, resource limits and optional hash.

    Persisted coordination data is treated as untrusted input.  A valid SQLite
    page does not prove the JSON bytes inside it are canonical or untampered.
    """

    if value is None:
        if default is not None:
            return default
        return None
    raw = value if isinstance(value, bytes) else value.encode("utf-8", "strict")
    if expected_sha256 is not None:
        try:
            validate_sha256_hex(expected_sha256, label=f"{label} hash")
        except ValueError as exc:
            raise PersistedDataCorruption(str(exc)) from exc
        actual = sha256_bytes(raw)
        if actual != expected_sha256:
            raise PersistedDataCorruption(
                f"{label} hash mismatch: expected {expected_sha256}, got {actual}"
            )
    try:
        parsed = strict_json_loads(raw)
        validate_json_resources(parsed)
        if require_canonical and canonical_json_bytes(parsed) != raw:
            raise PersistedDataCorruption(f"{label} is not A620-JCS-1 canonical")
        return parsed
    except PersistedDataCorruption:
        raise
    except (CanonicalJsonError, UnicodeError, ValueError, TypeError) as exc:
        raise PersistedDataCorruption(f"{label} cannot be decoded safely: {exc}") from exc


def load_blob(
    value: bytes | str | None,
    default: Any = None,
    *,
    expected_sha256: str | None = None,
    label: str = "persisted JSON",
    require_canonical: bool = True,
) -> Any:
    return verified_json_blob(
        value,
        expected_sha256=expected_sha256,
        label=label,
        default=default,
        require_canonical=require_canonical,
    )
