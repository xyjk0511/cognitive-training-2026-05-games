from __future__ import annotations
import os
from pathlib import Path

class EmergencyReserve:
    """Pre-allocated bytes reserved for a last durable interruption record.

    Production Android must place this file in the same app-private filesystem
    as the Room database. Releasing the reserve does not make a failed result
    valid; it only creates space to persist a fail-closed execution outcome.
    """
    def __init__(self, path: str | Path, size_bytes: int):
        if size_bytes <= 0:
            raise ValueError("size_bytes must be positive")
        self.path = Path(path)
        self.size_bytes = size_bytes

    def ensure(self) -> bool:
        if self.path.exists():
            if self.path.stat().st_size != self.size_bytes:
                raise RuntimeError("emergency reserve has unexpected size")
            return False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            if hasattr(os, "posix_fallocate"):
                os.posix_fallocate(fd, 0, self.size_bytes)
            else:
                chunk = b"\0" * min(1024 * 1024, self.size_bytes)
                remaining = self.size_bytes
                while remaining:
                    part = chunk if remaining >= len(chunk) else chunk[:remaining]
                    os.write(fd, part)
                    remaining -= len(part)
            os.fsync(fd)
        finally:
            os.close(fd)
        self._fsync_parent()
        return True

    def release(self) -> bool:
        try:
            self.path.unlink()
        except FileNotFoundError:
            return False
        self._fsync_parent()
        return True

    def _fsync_parent(self) -> None:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        fd = os.open(self.path.parent, flags)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
