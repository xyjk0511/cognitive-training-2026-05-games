from __future__ import annotations
import hashlib
import json
from typing import Any

SAFE_INTEGER_MAX = 2**53 - 1

class CanonicalJsonError(ValueError):
    pass

def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")

def _validate(value: Any, path: str = "$") -> None:
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if not -SAFE_INTEGER_MAX <= value <= SAFE_INTEGER_MAX:
            raise CanonicalJsonError(f"{path}: integer is outside JavaScript safe range")
        return
    if isinstance(value, float):
        raise CanonicalJsonError(f"{path}: floating-point values are forbidden")
    if isinstance(value, list):
        for i, item in enumerate(value):
            _validate(item, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalJsonError(f"{path}: object key is not a string")
            _validate(item, f"{path}.{key}")
        return
    raise CanonicalJsonError(f"{path}: unsupported JSON type {type(value).__name__}")

def _string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def _emit(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, list):
        return "[" + ",".join(_emit(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=_utf16_sort_key)
        return "{" + ",".join(_string(k) + ":" + _emit(value[k]) for k in keys) + "}"
    raise AssertionError(type(value))

def canonical_bytes(value: Any) -> bytes:
    _validate(value)
    return _emit(value).encode("utf-8")

def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()
