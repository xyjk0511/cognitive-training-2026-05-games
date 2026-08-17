from __future__ import annotations

import contextlib
import hashlib
import json
import math
import sqlite3
from pathlib import Path
from typing import Any, Iterator

SAFE_INTEGER = 9_007_199_254_740_991

def validate_json_value(value: Any, depth: int = 0) -> None:
    if depth > 64:
        raise ValueError("JSON nesting exceeds 64")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > SAFE_INTEGER:
            raise ValueError("integer exceeds JavaScript safe integer range")
        return
    if isinstance(value, float):
        raise ValueError("floating point values are forbidden")
    if isinstance(value, str):
        value.encode("utf-8", "strict")
        return
    if isinstance(value, list):
        if len(value) > 2048:
            raise ValueError("array exceeds resource budget")
        for item in value:
            validate_json_value(item, depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 2048:
            raise ValueError("object exceeds resource budget")
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("object keys must be strings")
            key.encode("utf-8", "strict")
            validate_json_value(item, depth + 1)
        return
    raise ValueError(f"unsupported JSON value: {type(value)!r}")

def canonical_json_bytes(value: Any) -> bytes:
    validate_json_value(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")

def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()

def connect(path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(
        str(path), timeout=5.0, isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA wal_autocheckpoint=1000")
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

def load_blob(value: bytes | str | None, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    return json.loads(value)
