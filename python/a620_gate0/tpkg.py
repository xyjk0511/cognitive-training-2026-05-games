from __future__ import annotations

import base64
import hashlib
import os
import re
import stat
import struct
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from packaging.version import InvalidVersion, Version

from .canonical import canonical_bytes, canonical_sha256, strict_json_loads
from .schema import validate_schema

MAX_ENTRIES = 4096
MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024
MAX_FILE_UNCOMPRESSED = 128 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
MAX_ARCHIVE_BYTES = 600 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_SIGNATURE_RECORD_BYTES = 16 * 1024
READ_CHUNK = 1024 * 1024
RESERVED_ARCHIVE_PATHS = {"manifest.json", "manifest.sig.json"}
ALLOWED_COMPRESSION = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def _deterministic_zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=FIXED_ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.flag_bits |= 0x800
    return info


class TpkgError(ValueError):
    pass


def _normalise_path(raw: str) -> str:
    if not raw or "\\" in raw or "\x00" in raw or raw.startswith("/"):
        raise TpkgError(f"unsafe archive path: {raw!r}")
    try:
        raw.encode("ascii")
    except UnicodeEncodeError as exc:
        raise TpkgError(f"archive paths must use portable ASCII: {raw!r}") from exc
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise TpkgError(f"unsafe archive path: {raw!r}")
    normal = str(path)
    if normal != raw:
        raise TpkgError(f"non-canonical archive path: {raw!r}")
    if any(not (part[0].isalnum() and all(ch.isalnum() or ch in "._-" for ch in part)) for part in path.parts):
        raise TpkgError(f"archive path contains unsupported characters: {raw!r}")
    return normal


def _is_regular(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    return file_type in {0, stat.S_IFREG}


def _content_tree(files: list[dict[str, Any]]) -> str:
    projection = [
        {"path": item["path"], "sizeBytes": item["sizeBytes"], "sha256": item["sha256"]}
        for item in sorted(files, key=lambda value: value["path"])
    ]
    return canonical_sha256(projection)


def _version(value: str, field: str) -> Version:
    try:
        return Version(value)
    except InvalidVersion as exc:
        raise TpkgError(f"{field} is not valid SemVer-compatible version: {value}") from exc


def _validate_manifest_semantics(manifest: dict[str, Any]) -> None:
    minimum = _version(manifest["minApkVersionInclusive"], "minApkVersionInclusive")
    maximum = _version(manifest["maxApkVersionExclusive"], "maxApkVersionExclusive")
    _version(manifest["packageVersion"], "packageVersion")
    _version(manifest["cocosVersion"], "cocosVersion")
    if minimum >= maximum:
        raise TpkgError("APK compatibility range must satisfy minInclusive < maxExclusive")

    declared_paths = [item["path"] for item in manifest["files"]]
    if len(declared_paths) != len(set(declared_paths)):
        raise TpkgError("manifest contains duplicate file paths")
    for raw in declared_paths:
        normal = _normalise_path(raw)
        if normal in RESERVED_ARCHIVE_PATHS:
            raise TpkgError(f"manifest content uses reserved path: {normal}")


def _read_and_hash(stream: BinaryIO, *, expected_size: int, path: str) -> tuple[int, str]:
    digest = hashlib.sha256()
    count = 0
    while True:
        chunk = stream.read(READ_CHUNK)
        if not chunk:
            break
        count += len(chunk)
        if count > expected_size or count > MAX_FILE_UNCOMPRESSED:
            raise TpkgError(f"actual uncompressed data exceeds declared/allowed size: {path}")
        digest.update(chunk)
    if count != expected_size:
        raise TpkgError(f"actual uncompressed size differs from ZIP metadata: {path}")
    return count, digest.hexdigest()


def _validate_zip_container_layout(path: Path) -> None:
    """Reject prepended/trailing payloads and multi-disk/noncanonical EOCD."""

    size = path.stat().st_size
    if size < 22:
        raise TpkgError("training package is too short to contain ZIP EOCD")
    window_size = min(size, 22 + 65535)
    with path.open("rb") as stream:
        stream.seek(size - window_size)
        tail = stream.read(window_size)
    position = tail.rfind(b"PK\x05\x06")
    if position < 0 or position + 22 > len(tail):
        raise TpkgError("training package has trailing data or a noncanonical EOCD")
    try:
        signature, disk_no, cd_disk, disk_entries, total_entries, cd_size, cd_offset, comment_len = struct.unpack(
            "<4s4H2LH", tail[position:position + 22]
        )
    except struct.error as exc:
        raise TpkgError("training package EOCD is malformed") from exc
    if signature != b"PK\x05\x06":
        raise TpkgError("training package EOCD signature is invalid")
    if position + 22 + comment_len != len(tail):
        raise TpkgError("training package has trailing data after EOCD")
    if comment_len != 0:
        raise TpkgError("archive comments are forbidden")
    if disk_no != 0 or cd_disk != 0 or disk_entries != total_entries:
        raise TpkgError("multi-disk ZIP archives are forbidden")
    absolute_eocd = size - window_size + position
    if cd_offset + cd_size != absolute_eocd:
        raise TpkgError("ZIP central directory does not exactly precede EOCD")


def _validate_trust_store(trust_store: dict[str, Any]) -> None:
    if set(trust_store) != {"trustStoreVersion", "minimumAcceptedReleaseSequence", "keys"}:
        raise TpkgError("trust store has unexpected or missing fields")
    if trust_store.get("trustStoreVersion") != 1:
        raise TpkgError("unsupported trust store version")
    minima = trust_store.get("minimumAcceptedReleaseSequence")
    if not isinstance(minima, dict) or len(minima) > 256:
        raise TpkgError("trust store minimum release map is malformed")
    for game_code, sequence in minima.items():
        if not isinstance(game_code, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", game_code):
            raise TpkgError("trust store contains invalid gameCode")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or not 1 <= sequence <= 9_007_199_254_740_991:
            raise TpkgError("trust store minimum release sequence is invalid")

    keys = trust_store.get("keys")
    if not isinstance(keys, list) or not 1 <= len(keys) <= 64:
        raise TpkgError("trust store key list is malformed")
    ids: set[str] = set()
    active = 0
    next_count = 0
    for item in keys:
        if not isinstance(item, dict) or set(item) != {"keyId", "status", "publicKeyHex"}:
            raise TpkgError("trust store key record is malformed")
        key_id = item["keyId"]
        if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", key_id):
            raise TpkgError("trust store keyId is invalid")
        if key_id in ids:
            raise TpkgError("trust store contains duplicate keyId")
        ids.add(key_id)
        status = item["status"]
        if status not in {"ACTIVE", "NEXT", "REVOKED"}:
            raise TpkgError("trust store key has unsupported status")
        active += status == "ACTIVE"
        next_count += status == "NEXT"
        public_hex = item["publicKeyHex"]
        if not isinstance(public_hex, str) or not re.fullmatch(r"[0-9a-f]{64}", public_hex):
            raise TpkgError("trust store Ed25519 public key is invalid")
    if active != 1:
        raise TpkgError("trust store must contain exactly one ACTIVE key")
    if next_count > 1:
        raise TpkgError("trust store may contain at most one NEXT key")


def _trust_key(trust_store: dict[str, Any], key_id: str) -> bytes:
    matches = [item for item in trust_store["keys"] if item["keyId"] == key_id]
    if len(matches) != 1:
        raise TpkgError("signing key is missing or duplicated in trust store")
    item = matches[0]
    status = item.get("status")
    if status == "REVOKED":
        raise TpkgError("signing key is revoked")
    if status not in {"ACTIVE", "NEXT"}:
        raise TpkgError("signing key has unsupported status")
    try:
        raw = bytes.fromhex(item["publicKeyHex"])
    except (KeyError, ValueError) as exc:
        raise TpkgError("trust store public key is invalid") from exc
    if len(raw) != 32:
        raise TpkgError("Ed25519 public key must be 32 bytes")
    return raw


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def build_tpkg(
    source_dir: Path,
    output_path: Path,
    manifest_base: dict[str, Any],
    private_key_hex: str,
) -> dict[str, Any]:
    """Build a deterministic package through an atomic sibling temporary file.

    Source files are hashed once for the signed manifest and a second time
    while they are streamed into the archive. A source mutation between those
    passes aborts the build; a failed build never leaves a partial final path.
    """

    source_dir = source_dir.resolve()
    if not source_dir.is_dir():
        raise TpkgError("training package source is not a directory")
    output_path = output_path.resolve()
    if output_path == source_dir or source_dir in output_path.parents:
        raise TpkgError("output package must not be placed inside the source tree")

    content_files: list[dict[str, Any]] = []
    for path in sorted(source_dir.rglob("*")):
        if path.is_symlink():
            raise TpkgError(f"source package may not contain symlinks: {path}")
        if not path.is_file():
            continue
        resolved = path.resolve()
        if source_dir not in resolved.parents:
            raise TpkgError(f"source file escapes package root: {path}")
        rel = _normalise_path(path.relative_to(source_dir).as_posix())
        if rel in RESERVED_ARCHIVE_PATHS:
            raise TpkgError(f"source package uses reserved path: {rel}")
        size = path.stat().st_size
        if size > MAX_FILE_UNCOMPRESSED:
            raise TpkgError(f"source file exceeds maximum size: {rel}")
        digest = hashlib.sha256()
        count = 0
        with path.open("rb") as stream:
            while chunk := stream.read(READ_CHUNK):
                count += len(chunk)
                if count > size:
                    raise TpkgError(f"source file grew while being hashed: {rel}")
                digest.update(chunk)
        if count != size:
            raise TpkgError(f"source file changed size while being hashed: {rel}")
        content_files.append({"path": rel, "sizeBytes": size, "sha256": digest.hexdigest()})

    if not content_files:
        raise TpkgError("training package contains no content files")
    if sum(item["sizeBytes"] for item in content_files) > MAX_TOTAL_UNCOMPRESSED:
        raise TpkgError("training package exceeds total uncompressed size limit")

    manifest = dict(manifest_base)
    manifest["files"] = content_files
    manifest["contentTreeSha256"] = _content_tree(content_files)
    validate_schema(manifest, "a620_training_package_manifest.schema.json")
    _validate_manifest_semantics(manifest)
    manifest_bytes = canonical_bytes(manifest)
    if len(manifest_bytes) > MAX_MANIFEST_BYTES:
        raise TpkgError("manifest exceeds size limit")

    try:
        private_bytes = bytes.fromhex(private_key_hex)
        private_key = Ed25519PrivateKey.from_private_bytes(private_bytes)
    except (ValueError, TypeError) as exc:
        raise TpkgError("Ed25519 private key must be a valid 32-byte hex seed") from exc
    signature = private_key.sign(manifest_bytes)
    signature_record = {
        "signatureProfile": "A620-ED25519-1",
        "signingKeyId": manifest["signingKeyId"],
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "signatureBase64": base64.b64encode(signature).decode("ascii"),
    }
    signature_bytes = canonical_bytes(signature_record)
    if len(signature_bytes) > MAX_SIGNATURE_RECORD_BYTES:
        raise TpkgError("signature record exceeds size limit")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
    os.close(fd)
    temporary_path = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            archive.comment = b""
            archive.writestr(_deterministic_zip_info("manifest.json"), manifest_bytes, compresslevel=9)
            archive.writestr(_deterministic_zip_info("manifest.sig.json"), signature_bytes, compresslevel=9)
            for entry in content_files:
                info = _deterministic_zip_info(entry["path"])
                digest = hashlib.sha256()
                count = 0
                with (source_dir / entry["path"]).open("rb") as source, archive.open(
                    info,
                    "w",
                    force_zip64=True,
                ) as target:
                    while chunk := source.read(READ_CHUNK):
                        count += len(chunk)
                        if count > entry["sizeBytes"]:
                            raise TpkgError(f"source file grew after manifest signing: {entry['path']}")
                        digest.update(chunk)
                        target.write(chunk)
                if count != entry["sizeBytes"] or digest.hexdigest() != entry["sha256"]:
                    raise TpkgError(f"source file changed after manifest signing: {entry['path']}")

        if temporary_path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise TpkgError("built archive exceeds compressed size limit")
        with temporary_path.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary_path, output_path)
        _fsync_directory(output_path.parent)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return manifest


def validate_tpkg(
    path: Path,
    trust_store: dict[str, Any],
    *,
    apk_version: str | None = None,
    minimum_release_sequence: int | None = None,
    expected_game_code: str | None = None,
) -> dict[str, Any]:
    try:
        if path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise TpkgError("training package compressed size exceeds limit")
        _validate_trust_store(trust_store)
        _validate_zip_container_layout(path)
        archive = zipfile.ZipFile(path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise TpkgError("training package is not a valid ZIP archive") from exc

    with archive:
        if archive.comment:
            raise TpkgError("archive comments are forbidden")
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise TpkgError("archive entry count exceeds limit")
        seen: set[str] = set()
        total = 0
        for info in infos:
            normal = _normalise_path(info.filename)
            if normal in seen:
                raise TpkgError(f"duplicate archive entry: {normal}")
            seen.add(normal)
            if info.comment:
                raise TpkgError(f"archive entry comments are forbidden: {normal}")
            if info.flag_bits & 0x1:
                raise TpkgError(f"encrypted archive entry is forbidden: {normal}")
            if info.compress_type not in ALLOWED_COMPRESSION:
                raise TpkgError(f"unsupported compression method: {normal}")
            if info.is_dir() or not _is_regular(info):
                raise TpkgError(f"non-regular archive entry: {normal}")
            if info.file_size > MAX_FILE_UNCOMPRESSED:
                raise TpkgError(f"entry exceeds maximum size: {normal}")
            total += info.file_size
            if total > MAX_TOTAL_UNCOMPRESSED:
                raise TpkgError("archive total uncompressed size exceeds limit")
            if info.compress_size == 0 and info.file_size > 0:
                raise TpkgError(f"invalid compression size: {normal}")
            if info.compress_size > 0 and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                raise TpkgError(f"compression ratio exceeds limit: {normal}")

        if not RESERVED_ARCHIVE_PATHS.issubset(seen):
            raise TpkgError("manifest files are missing")

        info_by_name = {info.filename: info for info in infos}
        if info_by_name["manifest.json"].file_size > MAX_MANIFEST_BYTES:
            raise TpkgError("manifest exceeds size limit")
        if info_by_name["manifest.sig.json"].file_size > MAX_SIGNATURE_RECORD_BYTES:
            raise TpkgError("signature record exceeds size limit")

        manifest_raw = archive.read("manifest.json")
        manifest = strict_json_loads(manifest_raw)
        validate_schema(manifest, "a620_training_package_manifest.schema.json")
        _validate_manifest_semantics(manifest)
        if canonical_bytes(manifest) != manifest_raw:
            raise TpkgError("manifest.json is not A620-JCS-1 canonical")

        signature_raw = archive.read("manifest.sig.json")
        signature_record = strict_json_loads(signature_raw)
        expected_signature_keys = {"signatureProfile", "signingKeyId", "manifestSha256", "signatureBase64"}
        if set(signature_record) != expected_signature_keys:
            raise TpkgError("manifest.sig.json has unexpected or missing fields")
        if canonical_bytes(signature_record) != signature_raw:
            raise TpkgError("manifest.sig.json is not A620-JCS-1 canonical")
        if signature_record["signatureProfile"] != manifest["signatureProfile"]:
            raise TpkgError("signature profile mismatch")
        if signature_record["signingKeyId"] != manifest["signingKeyId"]:
            raise TpkgError("signature key id mismatch")
        if signature_record["manifestSha256"] != hashlib.sha256(manifest_raw).hexdigest():
            raise TpkgError("manifest hash mismatch")

        public_key = Ed25519PublicKey.from_public_bytes(_trust_key(trust_store, manifest["signingKeyId"]))
        try:
            signature = base64.b64decode(signature_record["signatureBase64"], validate=True)
            if len(signature) != 64:
                raise ValueError("wrong Ed25519 signature length")
            public_key.verify(signature, manifest_raw)
        except Exception as exc:
            raise TpkgError("Ed25519 signature verification failed") from exc

        configured_minimum = trust_store.get("minimumAcceptedReleaseSequence", {}).get(manifest["gameCode"], 1)
        required_sequence = max(configured_minimum, minimum_release_sequence or 1)
        if manifest["releaseSequence"] < required_sequence:
            raise TpkgError("training package is below the minimum accepted release sequence")
        if expected_game_code is not None and manifest["gameCode"] != expected_game_code:
            raise TpkgError("training package gameCode does not match requested training")
        if apk_version is not None:
            apk = _version(apk_version, "apkVersion")
            minimum = _version(manifest["minApkVersionInclusive"], "minApkVersionInclusive")
            maximum = _version(manifest["maxApkVersionExclusive"], "maxApkVersionExclusive")
            if not minimum <= apk < maximum:
                raise TpkgError("training package is not compatible with the current APK version")

        declared_list = manifest["files"]
        declared = {item["path"]: item for item in declared_list}
        if len(declared) != len(declared_list):
            raise TpkgError("manifest contains duplicate declared paths")
        actual_content = seen - RESERVED_ARCHIVE_PATHS
        if set(declared) != actual_content:
            raise TpkgError("manifest file set does not match archive entries")

        computed: list[dict[str, Any]] = []
        for rel in sorted(actual_content):
            info = info_by_name[rel]
            with archive.open(info, "r") as stream:
                size, digest = _read_and_hash(stream, expected_size=info.file_size, path=rel)
            item = {"path": rel, "sizeBytes": size, "sha256": digest}
            if item != declared[rel]:
                raise TpkgError(f"file metadata mismatch: {rel}")
            computed.append(item)
        if _content_tree(computed) != manifest["contentTreeSha256"]:
            raise TpkgError("contentTreeSha256 mismatch")
        return manifest
