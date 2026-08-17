from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .canonical import canonical_bytes, strict_json_loads
from .generated_profiles import (
    IPC_FRAME_HEADER_BYTES, IPC_FRAME_MAX_FEED_CHUNK_BYTES,
    IPC_FRAME_MAX_PAYLOAD_BYTES, IPC_FRAME_MIN_PAYLOAD_BYTES,
)
from .wire import MAX_WIRE_MESSAGE_BYTES, parse_runtime_message

FRAME_HEADER_BYTES = IPC_FRAME_HEADER_BYTES
MIN_FRAME_PAYLOAD_BYTES = IPC_FRAME_MIN_PAYLOAD_BYTES
MAX_FRAME_PAYLOAD_BYTES = IPC_FRAME_MAX_PAYLOAD_BYTES
MAX_FEED_CHUNK_BYTES = IPC_FRAME_MAX_FEED_CHUNK_BYTES
if MAX_FRAME_PAYLOAD_BYTES != MAX_WIRE_MESSAGE_BYTES:
    raise RuntimeError("IPC frame and wire message byte limits diverged")


class IpcFrameError(ValueError):
    pass


def encode_frame(value: Any) -> bytes:
    payload = canonical_bytes(value)
    if not MIN_FRAME_PAYLOAD_BYTES <= len(payload) <= MAX_FRAME_PAYLOAD_BYTES:
        raise IpcFrameError("canonical payload size is outside A620-IPC-FRAME-1 limits")
    return len(payload).to_bytes(FRAME_HEADER_BYTES, "big", signed=False) + payload


def decode_canonical_payload(payload: bytes) -> Any:
    if not MIN_FRAME_PAYLOAD_BYTES <= len(payload) <= MAX_FRAME_PAYLOAD_BYTES:
        raise IpcFrameError("frame payload size is outside A620-IPC-FRAME-1 limits")
    value = strict_json_loads(payload)
    if canonical_bytes(value) != payload:
        raise IpcFrameError("frame payload is not A620-JCS-1 canonical JSON")
    return value


def decode_runtime_payload(payload: bytes) -> dict[str, Any]:
    value = decode_canonical_payload(payload)
    if not isinstance(value, dict):
        raise IpcFrameError("runtime frame root must be an object")
    return parse_runtime_message(payload)


@dataclass
class FrameDecoder:
    """Fail-closed streaming A620-IPC-FRAME-1 decoder.

    The decoder never concatenates an arbitrary read with its retained state.
    It retains at most a partial four-byte header or one declared payload, so a
    read containing several maximum-size frames is processed without a false
    buffer-overflow rejection or an avoidable second full-size copy.
    """

    _header: bytearray = field(default_factory=bytearray)
    _payload: bytearray = field(default_factory=bytearray)
    _expected_payload_bytes: int | None = None
    _failed: bool = False

    def _fail(self, message: str) -> None:
        self._failed = True
        self._header.clear()
        self._payload.clear()
        self._expected_payload_bytes = None
        raise IpcFrameError(message)

    def feed(self, chunk: bytes | bytearray | memoryview) -> list[bytes]:
        if self._failed:
            raise IpcFrameError("frame decoder is already failed")
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            self._fail("frame chunk must be bytes-like")
        view = memoryview(chunk).cast("B")
        if len(view) > MAX_FEED_CHUNK_BYTES:
            self._fail("frame feed chunk exceeds A620-IPC-FRAME-1 limit")

        frames: list[bytes] = []
        offset = 0
        while offset < len(view):
            if self._expected_payload_bytes is None:
                take = min(FRAME_HEADER_BYTES - len(self._header), len(view) - offset)
                self._header.extend(view[offset : offset + take])
                offset += take
                if len(self._header) < FRAME_HEADER_BYTES:
                    continue
                length = int.from_bytes(self._header, "big", signed=False)
                self._header.clear()
                if not MIN_FRAME_PAYLOAD_BYTES <= length <= MAX_FRAME_PAYLOAD_BYTES:
                    self._fail(f"invalid frame payload length: {length}")
                self._expected_payload_bytes = length

            expected = self._expected_payload_bytes
            assert expected is not None
            take = min(expected - len(self._payload), len(view) - offset)
            self._payload.extend(view[offset : offset + take])
            offset += take
            if len(self._payload) == expected:
                frames.append(bytes(self._payload))
                self._payload.clear()
                self._expected_payload_bytes = None

        return frames

    @property
    def retained_bytes(self) -> int:
        return len(self._header) + len(self._payload)

    def finish(self) -> None:
        if self._failed:
            raise IpcFrameError("frame decoder is already failed")
        if self._expected_payload_bytes is not None or self._header or self._payload:
            self._fail("channel closed with a trailing partial frame")
