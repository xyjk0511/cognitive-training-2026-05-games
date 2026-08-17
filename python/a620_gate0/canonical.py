from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from .generated_profiles import (
    JSON_MAX_ARRAY_ITEMS, JSON_MAX_DEPTH, JSON_MAX_OBJECT_KEY_UTF8_BYTES,
    JSON_MAX_OBJECT_MEMBERS, JSON_MAX_STRING_UTF8_BYTES,
    JSON_MAX_TOTAL_NODES, JSON_MAX_TOTAL_STRING_UTF8_BYTES,
)

SAFE_INTEGER_MAX = 2**53 - 1


@dataclass(frozen=True)
class JsonResourceLimits:
    max_depth: int = JSON_MAX_DEPTH
    max_total_nodes: int = JSON_MAX_TOTAL_NODES
    max_object_members: int = JSON_MAX_OBJECT_MEMBERS
    max_array_items: int = JSON_MAX_ARRAY_ITEMS
    max_string_utf8_bytes: int = JSON_MAX_STRING_UTF8_BYTES
    max_object_key_utf8_bytes: int = JSON_MAX_OBJECT_KEY_UTF8_BYTES
    max_total_string_utf8_bytes: int = JSON_MAX_TOTAL_STRING_UTF8_BYTES


A620_JSON_RESOURCE_LIMITS = JsonResourceLimits()


class CanonicalJsonError(ValueError):
    pass


@dataclass
class _ValidationBudget:
    nodes: int = 0
    total_string_bytes: int = 0


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")


def _validate_string(value: str, path: str, *, byte_limit: int, budget: _ValidationBudget) -> None:
    # Python normally decodes supplementary Unicode as one code point. Any
    # remaining UTF-16 surrogate code point is therefore unpaired/malformed
    # and would be replaced differently by JavaScript/JVM UTF-8 encoders.
    for index, char in enumerate(value):
        if 0xD800 <= ord(char) <= 0xDFFF:
            raise CanonicalJsonError(f"{path}[{index}]: unpaired UTF-16 surrogate is forbidden")
    encoded_length = len(value.encode("utf-8", errors="strict"))
    if encoded_length > byte_limit:
        raise CanonicalJsonError(f"{path}: UTF-8 string exceeds {byte_limit} bytes")
    budget.total_string_bytes += encoded_length
    if budget.total_string_bytes > A620_JSON_RESOURCE_LIMITS.max_total_string_utf8_bytes:
        raise CanonicalJsonError("JSON total UTF-8 string budget exceeded")


def _validate(
    value: Any,
    path: str = "$",
    *,
    depth: int = 0,
    budget: _ValidationBudget | None = None,
) -> None:
    limits = A620_JSON_RESOURCE_LIMITS
    if budget is None:
        budget = _ValidationBudget()
    if depth > limits.max_depth:
        raise CanonicalJsonError(f"{path}: JSON nesting exceeds depth {limits.max_depth}")
    budget.nodes += 1
    if budget.nodes > limits.max_total_nodes:
        raise CanonicalJsonError(f"{path}: JSON node budget exceeds {limits.max_total_nodes}")

    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        _validate_string(value, path, byte_limit=limits.max_string_utf8_bytes, budget=budget)
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if not -SAFE_INTEGER_MAX <= value <= SAFE_INTEGER_MAX:
            raise CanonicalJsonError(f"{path}: integer is outside JavaScript safe range")
        return
    if isinstance(value, float):
        raise CanonicalJsonError(f"{path}: floating-point values are forbidden")
    if isinstance(value, list):
        if len(value) > limits.max_array_items:
            raise CanonicalJsonError(f"{path}: array exceeds {limits.max_array_items} items")
        for i, item in enumerate(value):
            _validate(item, f"{path}[{i}]", depth=depth + 1, budget=budget)
        return
    if isinstance(value, dict):
        if len(value) > limits.max_object_members:
            raise CanonicalJsonError(f"{path}: object exceeds {limits.max_object_members} members")
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalJsonError(f"{path}: object key is not a string")
            _validate_string(
                key,
                f"{path}.<key>",
                byte_limit=limits.max_object_key_utf8_bytes,
                budget=budget,
            )
            _validate(item, f"{path}.{key}", depth=depth + 1, budget=budget)
        return
    raise CanonicalJsonError(f"{path}: unsupported JSON type {type(value).__name__}")


def validate_json_resources(value: Any) -> None:
    """Apply A620-JRP-1 independently of serialization."""

    _validate(value)


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
    """Parse JSON while rejecting duplicate keys, unsafe values and resource abuse.

    Standard ``json.loads`` silently keeps the last duplicate key. That is
    incompatible with A620-JCS-1 because two byte streams could otherwise map
    to the same in-memory object before signature verification. A620-JRP-1 is
    applied immediately after parsing, and parser recursion failures are
    normalized into a protocol error instead of escaping as ``RecursionError``.
    """

    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise CanonicalJsonError("JSON is not valid UTF-8") from exc

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        if len(pairs) > A620_JSON_RESOURCE_LIMITS.max_object_members:
            raise CanonicalJsonError(
                f"object exceeds {A620_JSON_RESOURCE_LIMITS.max_object_members} members"
            )
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
    except RecursionError as exc:
        raise CanonicalJsonError(
            f"JSON nesting exceeds depth {A620_JSON_RESOURCE_LIMITS.max_depth}"
        ) from exc
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise CanonicalJsonError(f"invalid JSON: {exc}") from exc
    _validate(value)
    return value
