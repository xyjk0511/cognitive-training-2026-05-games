from __future__ import annotations

from typing import Any

from .canonical import CanonicalJsonError, strict_json_loads
from .schema import validate_schema


class WireMessageError(ValueError):
    pass


MAX_WIRE_MESSAGE_BYTES = 2 * 1024 * 1024
DEFAULT_MESSAGE_BYTES = 64 * 1024
MESSAGE_BYTE_LIMITS = {
    "PREPARE": 512 * 1024,
    "BATCH_CLOSED": 256 * 1024,
    "STATE_SNAPSHOT": 256 * 1024,
    "RESULT_READY": MAX_WIRE_MESSAGE_BYTES,
    "HEARTBEAT": 16 * 1024,
    "RUNTIME_ERROR": 64 * 1024,
}


def parse_runtime_message(raw: bytes | str) -> dict[str, Any]:
    """Strictly parse one runtime message before DTO/state processing.

    Limits are applied to received bytes, not only to the parsed object, so
    whitespace inflation cannot consume unbounded Binder/native bridge memory.
    Duplicate keys, floats, unsafe integers, malformed UTF-8 and non-JSON
    constants are rejected by the canonical parser.
    """

    if isinstance(raw, str):
        try:
            encoded = raw.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise WireMessageError("runtime message string is not valid UTF-8") from exc
    else:
        encoded = raw
    if not encoded:
        raise WireMessageError("runtime message is empty")
    if len(encoded) > MAX_WIRE_MESSAGE_BYTES:
        raise WireMessageError("runtime message exceeds global byte limit")
    try:
        value = strict_json_loads(encoded)
    except CanonicalJsonError as exc:
        raise WireMessageError(str(exc)) from exc
    if not isinstance(value, dict):
        raise WireMessageError("runtime message root must be an object")
    message_type = value.get("messageType")
    if not isinstance(message_type, str):
        raise WireMessageError("runtime messageType is missing or invalid")
    limit = MESSAGE_BYTE_LIMITS.get(message_type, DEFAULT_MESSAGE_BYTES)
    if len(encoded) > limit:
        raise WireMessageError(f"{message_type} exceeds its {limit}-byte wire limit")
    try:
        validate_schema(value, "a620_training_runtime_message.schema.json")
    except Exception as exc:
        raise WireMessageError(str(exc)) from exc
    return value
