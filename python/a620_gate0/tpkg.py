from __future__ import annotations

import base64
import hashlib
import stat
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


def _trust_key(trust_store: dict[str, Any], key_id: str) -> bytes:
    if trust_store.get("trustStoreVersion") != 1 or not isinstance(trust_store.get("keys"), list):
        raise TpkgError("unsupported or malformed trust store")
    matches = [item for item in trust_store["keys"] if item.get("keyId") == key_id]
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


def build_tpkg(
    source_dir: Path,
    output_path: Path,
    manifest_base: dict[str, Any],
    private_key_hex: str,
) -> dict[str, Any]:
    source_dir = source_dir.resolve()
    content_files: list[dict[str, Any]] = []
    for path in sorted(source_dir.rglob("*")):
        if path.is_symlink():
            raise TpkgError(f"source package may not contain symlinks: {path}")
        if not path.is_file():
            continue
        resolved = path.resolve()
        if source_dir not in resolved.parents:
            raise TpkgError(f"source file escapes package root: {path}")
        rel = path.relative_to(source_dir).as_posix()
        rel = _normalise_path(rel)
        if rel in RESERVED_ARCHIVE_PATHS:
            raise TpkgError(f"source package uses reserved path: {rel}")
        size = path.stat().st_size
        if size > MAX_FILE_UNCOMPRESSED:
            raise TpkgError(f"source file exceeds maximum size: {rel}")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(READ_CHUNK):
                digest.update(chunk)
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

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
        archive.writestr(_deterministic_zip_info("manifest.json"), manifest_bytes, compresslevel=9)
        archive.writestr(
            _deterministic_zip_info("manifest.sig.json"),
            canonical_bytes(signature_record),
            compresslevel=9,
        )
        for entry in content_files:
            info = _deterministic_zip_info(entry["path"])
            # Stream source files into the deterministic archive so the
            # builder's memory use is bounded even near the per-file limit.
            with (source_dir / entry["path"]).open("rb") as source, archive.open(
                info,
                "w",
                force_zip64=True,
            ) as target:
                while chunk := source.read(READ_CHUNK):
                    target.write(chunk)
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
        archive = zipfile.ZipFile(path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise TpkgError("training package is not a valid ZIP archive") from exc

    with archive:
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

        info_by_name = {info.filename: info for info in infos}
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
