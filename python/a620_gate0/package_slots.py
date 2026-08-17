from __future__ import annotations

import fcntl
import hashlib
import os
import shutil
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .canonical import CanonicalJsonError, canonical_bytes, strict_json_loads
from .tpkg import TpkgError, validate_tpkg


class PackageActivationError(ValueError):
    pass


@dataclass(frozen=True)
class ActivePackage:
    game_code: str
    slot: str
    package_version: str
    release_sequence: int
    package_sha256: str
    path: Path


def _fsync_directory(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class TrainingPackageSlots:
    """A/B training-package installation with durable anti-rollback state.

    The active pointer is the commit record. Package bytes are staged and fully
    validated in the inactive slot before that pointer is atomically replaced.
    A monotonic release floor prevents pointer loss from silently re-enabling an
    older package, while a process lock serializes maintenance operations.
    """

    POINTER_NAME = "active-package.json"
    BACKUP_POINTER_NAME = "active-package.backup.json"
    RELEASE_FLOOR_NAME = "release-floor.json"
    LOCK_NAME = ".package-install.lock"
    SLOT_NAMES = ("slot-a", "slot-b")
    POINTER_FIELDS = {
        "pointerVersion", "gameCode", "activeSlot", "packageVersion", "releaseSequence", "packageSha256",
    }

    def __init__(self, root: Path, trust_store: dict[str, Any], *, apk_version: str) -> None:
        self.root = root.resolve()
        self.trust_store = trust_store
        self.apk_version = apk_version
        self.root.mkdir(parents=True, exist_ok=True)

    def _game_root(self, game_code: str) -> Path:
        return self.root / game_code.lower().replace("_", "-")

    def _pointer_path(self, game_code: str) -> Path:
        return self._game_root(game_code) / self.POINTER_NAME

    def _backup_pointer_path(self, game_code: str) -> Path:
        return self._game_root(game_code) / self.BACKUP_POINTER_NAME

    def _floor_path(self, game_code: str) -> Path:
        return self._game_root(game_code) / self.RELEASE_FLOOR_NAME

    def _slot_package(self, game_code: str, slot: str) -> Path:
        return self._game_root(game_code) / slot / "training.tpkg"

    @contextmanager
    def _maintenance_lock(self, game_code: str) -> Iterator[None]:
        game_root = self._game_root(game_code)
        game_root.mkdir(parents=True, exist_ok=True)
        lock_path = game_root / self.LOCK_NAME
        with lock_path.open("a+b") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _read_canonical_object(path: Path, *, description: str) -> dict[str, Any] | None:
        if not path.exists():
            return None
        raw = path.read_bytes()
        try:
            value = strict_json_loads(raw)
        except CanonicalJsonError as exc:
            raise PackageActivationError(f"{description} is invalid JSON") from exc
        if not isinstance(value, dict) or canonical_bytes(value) != raw:
            raise PackageActivationError(f"{description} is not canonical JSON")
        return value

    @staticmethod
    def _write_atomic(path: Path, value: dict[str, Any], *, prefix: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=prefix, suffix=".tmp", dir=path.parent)
        os.close(fd)
        temporary = Path(temp_name)
        try:
            with temporary.open("wb") as stream:
                stream.write(canonical_bytes(value))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            _fsync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    def _read_pointer_path(self, path: Path, game_code: str) -> dict[str, Any] | None:
        value = self._read_canonical_object(path, description=path.name)
        if value is None:
            return None
        if set(value) != self.POINTER_FIELDS or value["gameCode"] != game_code or value["activeSlot"] not in self.SLOT_NAMES:
            raise PackageActivationError(f"{path.name} is malformed")
        if not isinstance(value["releaseSequence"], int) or isinstance(value["releaseSequence"], bool) or value["releaseSequence"] < 1:
            raise PackageActivationError(f"{path.name} releaseSequence is invalid")
        return value

    def _release_floor(self, game_code: str) -> int:
        value = self._read_canonical_object(self._floor_path(game_code), description=self.RELEASE_FLOOR_NAME)
        if value is None:
            return 0
        if set(value) != {"floorVersion", "gameCode", "minimumReleaseSequence"} or value["gameCode"] != game_code:
            raise PackageActivationError("release floor is malformed")
        sequence = value["minimumReleaseSequence"]
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
            raise PackageActivationError("release floor sequence is invalid")
        return sequence

    def _advance_floor(self, game_code: str, release_sequence: int) -> None:
        current = self._release_floor(game_code)
        if release_sequence <= current:
            return
        self._write_atomic(
            self._floor_path(game_code),
            {
                "floorVersion": "A620-TPF-1.1",
                "gameCode": game_code,
                "minimumReleaseSequence": release_sequence,
            },
            prefix=".floor-",
        )

    def _resolve_pointer(self, game_code: str, pointer: dict[str, Any]) -> ActivePackage:
        floor = self._release_floor(game_code)
        if pointer["releaseSequence"] < floor:
            raise PackageActivationError("active package pointer is below the durable release floor")
        path = self._slot_package(game_code, pointer["activeSlot"])
        if not path.is_file() or _sha256_file(path) != pointer["packageSha256"]:
            raise PackageActivationError("active package file is missing or differs from pointer")
        try:
            manifest = validate_tpkg(
                path,
                self.trust_store,
                apk_version=self.apk_version,
                minimum_release_sequence=max(pointer["releaseSequence"], floor),
                expected_game_code=game_code,
            )
        except TpkgError as exc:
            raise PackageActivationError(f"active package validation failed: {exc}") from exc
        if manifest["packageVersion"] != pointer["packageVersion"] or manifest["releaseSequence"] != pointer["releaseSequence"]:
            raise PackageActivationError("active package manifest differs from pointer")
        return ActivePackage(
            game_code=game_code,
            slot=pointer["activeSlot"],
            package_version=pointer["packageVersion"],
            release_sequence=pointer["releaseSequence"],
            package_sha256=pointer["packageSha256"],
            path=path,
        )

    def active(self, game_code: str) -> ActivePackage | None:
        pointer = self._read_pointer_path(self._pointer_path(game_code), game_code)
        return None if pointer is None else self._resolve_pointer(game_code, pointer)

    def install(
        self,
        package_path: Path,
        *,
        expected_game_code: str,
        maintenance_state: str,
        inject_failure_before_pointer: bool = False,
    ) -> ActivePackage:
        if maintenance_state != "IDLE_NO_TASK":
            raise PackageActivationError("training packages may only be activated in IDLE_NO_TASK maintenance state")

        with self._maintenance_lock(expected_game_code):
            current = self.active(expected_game_code)
            floor = self._release_floor(expected_game_code)

            # Idempotent replay is decided only after ``active()`` has
            # revalidated the current slot against the *current* trust store,
            # APK compatibility range and durable release floor. Do not catch a
            # broad validation failure and silently reinterpret it as replay.
            incoming_sha256 = _sha256_file(package_path)
            if current and incoming_sha256 == current.package_sha256:
                return current

            minimum = max(floor + 1, current.release_sequence + 1 if current else 1)
            try:
                manifest = validate_tpkg(
                    package_path,
                    self.trust_store,
                    apk_version=self.apk_version,
                    minimum_release_sequence=minimum,
                    expected_game_code=expected_game_code,
                )
            except TpkgError as exc:
                raise PackageActivationError(str(exc)) from exc

            inactive = "slot-b" if current and current.slot == "slot-a" else "slot-a"
            destination = self._slot_package(expected_game_code, inactive)
            destination.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix=".incoming-", suffix=".tpkg", dir=destination.parent)
            os.close(fd)
            temporary = Path(temp_name)
            try:
                with package_path.open("rb") as source, temporary.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                    target.flush()
                    os.fsync(target.fileno())
                staged_manifest = validate_tpkg(
                    temporary,
                    self.trust_store,
                    apk_version=self.apk_version,
                    minimum_release_sequence=minimum,
                    expected_game_code=expected_game_code,
                )
                if staged_manifest != manifest:
                    raise PackageActivationError("staged package manifest changed during copy")
                os.replace(temporary, destination)
                _fsync_directory(destination.parent)

                if inject_failure_before_pointer:
                    raise RuntimeError("injected failure before active pointer switch")

                pointer = {
                    "pointerVersion": "A620-TPA-1.1",
                    "gameCode": expected_game_code,
                    "activeSlot": inactive,
                    "packageVersion": manifest["packageVersion"],
                    "releaseSequence": manifest["releaseSequence"],
                    "packageSha256": _sha256_file(destination),
                }
                pointer_path = self._pointer_path(expected_game_code)
                old_pointer = self._read_pointer_path(pointer_path, expected_game_code)
                if old_pointer is not None:
                    self._write_atomic(self._backup_pointer_path(expected_game_code), old_pointer, prefix=".backup-")
                self._write_atomic(pointer_path, pointer, prefix=".active-")

                # Pointer switch is the activation commit. The floor is advanced
                # afterwards; if power fails between them, recovery validates
                # the active pointer and heals the floor upward.
                self._advance_floor(expected_game_code, manifest["releaseSequence"])
            finally:
                temporary.unlink(missing_ok=True)

            active = self.active(expected_game_code)
            if active is None:
                raise PackageActivationError("package activation pointer was not established")
            return active

    def recover(self, game_code: str) -> ActivePackage | None:
        with self._maintenance_lock(game_code):
            game_root = self._game_root(game_code)
            if not game_root.exists():
                return None
            for path in game_root.rglob("*.tmp"):
                path.unlink(missing_ok=True)
            for path in game_root.rglob(".incoming-*.tpkg"):
                path.unlink(missing_ok=True)

            try:
                active = self.active(game_code)
                if active is not None:
                    self._advance_floor(game_code, active.release_sequence)
                    return active
            except (PackageActivationError, TpkgError):
                pass

            floor = self._release_floor(game_code)
            # The release floor records the last package whose activation was
            # committed. A fully validated package may already exist in the
            # inactive slot when power fails before the pointer switch. Never
            # promote that uncommitted candidate merely because it has the
            # highest releaseSequence. With no valid pointer, reconstruct only
            # the exact committed floor; floor=0 means no activation can be
            # proven and therefore no package is exposed.
            candidates: list[tuple[int, str, dict[str, Any], Path]] = []
            if floor > 0:
                for slot in self.SLOT_NAMES:
                    path = self._slot_package(game_code, slot)
                    if not path.is_file():
                        continue
                    try:
                        manifest = validate_tpkg(
                            path,
                            self.trust_store,
                            apk_version=self.apk_version,
                            minimum_release_sequence=floor,
                            expected_game_code=game_code,
                        )
                    except TpkgError:
                        continue
                    if manifest["releaseSequence"] == floor:
                        candidates.append((manifest["releaseSequence"], slot, manifest, path))
            if not candidates:
                self._pointer_path(game_code).unlink(missing_ok=True)
                return None

            _, slot, manifest, path = candidates[0]
            pointer = {
                "pointerVersion": "A620-TPA-1.1",
                "gameCode": game_code,
                "activeSlot": slot,
                "packageVersion": manifest["packageVersion"],
                "releaseSequence": manifest["releaseSequence"],
                "packageSha256": _sha256_file(path),
            }
            self._write_atomic(self._pointer_path(game_code), pointer, prefix=".recover-")
            self._advance_floor(game_code, manifest["releaseSequence"])
            return self.active(game_code)
