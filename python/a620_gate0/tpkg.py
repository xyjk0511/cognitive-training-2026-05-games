from __future__ import annotations
import base64
import hashlib
import json
import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from .canonical import canonical_bytes, canonical_sha256
from .schema import validate_schema

MAX_ENTRIES = 4096
MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024
MAX_FILE_UNCOMPRESSED = 128 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class TpkgError(ValueError):
    pass

def _semver_core(value: str) -> tuple[int, int, int, tuple[str, ...]]:
    main, _, suffix = value.partition("-")
    core = main.split("+")[0].split(".")
    if len(core) != 3 or not all(part.isdigit() for part in core):
        raise TpkgError(f"invalid semantic version: {value}")
    prerelease = tuple(suffix.split("+", 1)[0].split(".")) if suffix else ()
    return int(core[0]), int(core[1]), int(core[2]), prerelease

def _semver_less(a: str, b: str) -> bool:
    ac = _semver_core(a); bc = _semver_core(b)
    if ac[:3] != bc[:3]: return ac[:3] < bc[:3]
    ap, bp = ac[3], bc[3]
    if not ap and bp: return False
    if ap and not bp: return True
    return ap < bp

def _normalise_path(raw: str) -> str:
    if not raw or "\\" in raw or "\x00" in raw or raw.startswith("/"):
        raise TpkgError(f"unsafe archive path: {raw!r}")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise TpkgError(f"unsafe archive path: {raw!r}")
    normal = str(path)
    if normal != raw:
        raise TpkgError(f"non-canonical archive path: {raw!r}")
    return normal

def _is_regular(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    return file_type in {0, stat.S_IFREG}

def _deterministic_zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=FIXED_ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.flag_bits |= 0x800
    return info

def _content_tree(files: list[dict[str, Any]]) -> str:
    projection = [{"path": f["path"], "sizeBytes": f["sizeBytes"], "sha256": f["sha256"]} for f in sorted(files, key=lambda x: x["path"])]
    return canonical_sha256(projection)

def build_tpkg(source_dir: Path, output_path: Path, manifest_base: dict[str, Any], private_key_hex: str) -> dict[str, Any]:
    content_files: list[dict[str, Any]] = []
    for path in sorted(source_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(source_dir).as_posix()
        _normalise_path(rel)
        data = path.read_bytes()
        content_files.append({"path": rel, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    if not content_files:
        raise TpkgError("training package contains no content files")
    manifest = dict(manifest_base)
    manifest["files"] = content_files
    manifest["contentTreeSha256"] = _content_tree(content_files)
    validate_schema(manifest, "a620_training_package_manifest.schema.json")
    manifest_bytes = canonical_bytes(manifest)
    private_key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex))
    signature = private_key.sign(manifest_bytes)
    signature_record = {
        "signatureProfile": "A620-ED25519-1",
        "signingKeyId": manifest["signingKeyId"],
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "signatureBase64": base64.b64encode(signature).decode("ascii"),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr(_deterministic_zip_info("manifest.json"), manifest_bytes, compresslevel=9)
        zf.writestr(
            _deterministic_zip_info("manifest.sig.json"),
            canonical_bytes(signature_record),
            compresslevel=9,
        )
        for entry in content_files:
            data = (source_dir / entry["path"]).read_bytes()
            zf.writestr(_deterministic_zip_info(entry["path"]), data, compresslevel=9)
    return manifest

def validate_tpkg(path: Path, trust_store: dict[str, str]) -> dict[str, Any]:
    with zipfile.ZipFile(path, "r") as zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise TpkgError("archive entry count exceeds limit")
        seen: set[str] = set()
        total = 0
        for info in infos:
            normal = _normalise_path(info.filename)
            if normal in seen:
                raise TpkgError(f"duplicate archive entry: {normal}")
            seen.add(normal)
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
        if "manifest.json" not in seen or "manifest.sig.json" not in seen:
            raise TpkgError("manifest files are missing")
        manifest_raw = zf.read("manifest.json")
        manifest = json.loads(manifest_raw.decode("utf-8"))
        validate_schema(manifest, "a620_training_package_manifest.schema.json")
        if canonical_bytes(manifest) != manifest_raw:
            raise TpkgError("manifest.json is not A620-JCS-1 canonical")
        if not _semver_less(manifest["minApkVersionInclusive"], manifest["maxApkVersionExclusive"]):
            raise TpkgError("minApkVersionInclusive must be lower than maxApkVersionExclusive")
        signature_raw = zf.read("manifest.sig.json")
        signature_record = json.loads(signature_raw.decode("utf-8"))
        if canonical_bytes(signature_record) != signature_raw:
            raise TpkgError("manifest.sig.json is not A620-JCS-1 canonical")
        if signature_record.get("signatureProfile") != "A620-ED25519-1":
            raise TpkgError("signature profile mismatch")
        if signature_record.get("signingKeyId") != manifest["signingKeyId"]:
            raise TpkgError("signature key id mismatch")
        if signature_record.get("manifestSha256") != hashlib.sha256(manifest_raw).hexdigest():
            raise TpkgError("manifest hash mismatch")
        key_id = manifest["signingKeyId"]
        if key_id not in trust_store:
            raise TpkgError("unknown signing key")
        public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(trust_store[key_id]))
        try:
            public_key.verify(base64.b64decode(signature_record["signatureBase64"]), manifest_raw)
        except Exception as exc:
            raise TpkgError("Ed25519 signature verification failed") from exc

        declared = {f["path"]: f for f in manifest["files"]}
        actual_content = seen - {"manifest.json", "manifest.sig.json"}
        if set(declared) != actual_content:
            raise TpkgError("manifest file set does not match archive entries")
        computed: list[dict[str, Any]] = []
        for rel in sorted(actual_content):
            data = zf.read(rel)
            item = {"path": rel, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            if item != declared[rel]:
                raise TpkgError(f"file metadata mismatch: {rel}")
            computed.append(item)
        if _content_tree(computed) != manifest["contentTreeSha256"]:
            raise TpkgError("contentTreeSha256 mismatch")
        return manifest
