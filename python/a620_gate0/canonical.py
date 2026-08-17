from __future__ import annotations

import hashlib
import json
from typing import Any

SAFE_INTEGER_MAX = 2**53 - 1


class CanonicalJsonError(ValueError):
    pass


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")


def _validate_string(value: str, path: str) -> None:
    # Python normally decodes supplementary Unicode as one code point. Any
    # remaining UTF-16 surrogate code point is therefore unpaired/malformed
    # and would be replaced differently by JavaScript/JVM UTF-8 encoders.
    for index, char in enumerate(value):
        if 0xD800 <= ord(char) <= 0xDFFF:
            raise CanonicalJsonError(f"{path}[{index}]: unpaired UTF-16 surrogate is forbidden")


def _validate(value: Any, path: str = "$") -> None:
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        _validate_string(value, path)
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
            _validate_string(key, f"{path}.<key>")
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


def strict_json_loads(text: str | bytes) -> Any:
    """Parse JSON while rejecting duplicate object keys and invalid constants.

    Standard ``json.loads`` silently keeps the last duplicate key. That is
    incompatible with A620-JCS-1 because two byte streams could otherwise map
    to the same in-memory object before signature verification.
    """

    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise CanonicalJsonError("JSON is not valid UTF-8") from exc

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise CanonicalJsonError(f"duplicate object key: {key!r}")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise CanonicalJsonError(f"non-JSON numeric constant is forbidden: {value}")

    try:
        value = json.loads(
            text,
            object_pairs_hook=object_pairs,
            parse_constant=invalid_constant,
        )
    except CanonicalJsonError:
        raise
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise CanonicalJsonError(f"invalid JSON: {exc}") from exc
    _validate(value)
    return value
