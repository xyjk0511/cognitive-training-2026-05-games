from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "normative" / "storage_integrity_profile.json"
OUT = ROOT / "generated"


def canonical(obj):
    if obj is None: return "null"
    if obj is True: return "true"
    if obj is False: return "false"
    if isinstance(obj, int): return str(obj)
    if isinstance(obj, str): return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    if isinstance(obj, list): return "[" + ",".join(canonical(x) for x in obj) + "]"
    if isinstance(obj, dict):
        keys = sorted(obj, key=lambda x: x.encode("utf-16-be"))
        return "{" + ",".join(canonical(k) + ":" + canonical(obj[k]) for k in keys) + "}"
    raise TypeError(type(obj))


def contents():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    digest = hashlib.sha256(canonical(data).encode()).hexdigest()
    py = f'''# Generated; do not edit.\nPROFILE_SHA256 = {digest!r}\nRUNTIME_STORAGE_PROFILE = {data["runtimeStorageProfile"]!r}\nRUNTIME_SCHEMA_VERSION = {data["runtimeSchemaVersion"]}\nPACKAGE_STORAGE_PROFILE = {data["packageStorageProfile"]!r}\nPACKAGE_SCHEMA_VERSION = {data["packageSchemaVersion"]}\nRUNTIME_WATCHDOG_SENTINEL = {data["runtimeWatchdogNullSourceKey"]!r}\n'''
    ts = f'''// Generated; do not edit.\nexport const STORAGE_PROFILE_SHA256 = "{digest}";\nexport const RUNTIME_STORAGE_PROFILE = "{data["runtimeStorageProfile"]}";\nexport const RUNTIME_SCHEMA_VERSION = {data["runtimeSchemaVersion"]};\nexport const PACKAGE_STORAGE_PROFILE = "{data["packageStorageProfile"]}";\nexport const PACKAGE_SCHEMA_VERSION = {data["packageSchemaVersion"]};\nexport const RUNTIME_WATCHDOG_SENTINEL = "{data["runtimeWatchdogNullSourceKey"]}";\n'''
    kt = f'''// Generated; do not edit.\npackage a620.baseline6\n\nobject StorageProfiles {{\n    const val PROFILE_SHA256 = "{digest}"\n    const val RUNTIME_STORAGE_PROFILE = "{data["runtimeStorageProfile"]}"\n    const val RUNTIME_SCHEMA_VERSION = {data["runtimeSchemaVersion"]}\n    const val PACKAGE_STORAGE_PROFILE = "{data["packageStorageProfile"]}"\n    const val PACKAGE_SCHEMA_VERSION = {data["packageSchemaVersion"]}\n    const val RUNTIME_WATCHDOG_SENTINEL = "{data["runtimeWatchdogNullSourceKey"]}"\n}}\n'''
    return {
        ROOT.parent / "baseline5_hardening" / "a620_coordination" / "generated_storage_profiles.py": py,
        OUT / "storage_profiles.py": py,
        OUT / "storage_profiles.ts": ts,
        OUT / "StorageProfiles.kt": kt,
        OUT / "profile.sha256": digest + "\n",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = contents()
    if args.check:
        bad = [str(path) for path, text in expected.items() if not path.exists() or path.read_text() != text]
        if bad:
            raise SystemExit("generated storage profiles are stale: " + ", ".join(bad))
        return
    OUT.mkdir(parents=True, exist_ok=True)
    for path, text in expected.items():
        path.write_text(text)

if __name__ == "__main__":
    main()
