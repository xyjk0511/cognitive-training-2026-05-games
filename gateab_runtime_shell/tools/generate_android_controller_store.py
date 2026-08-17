from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PATH = ROOT / "normative/android_controller_store_profile.json"
SQL_PATH = ROOT / "android/app/schemas/runtime_store_v4.sql"
OUTPUT = ROOT / "android/app/src/main/java/com/a620/tablet/training/GeneratedRuntimeStoreSchema.kt"
MARKER = "-- A620_STATEMENT"


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def kotlin_string(value: str) -> str:
    return '"""' + value.replace('"""', '\\"\\"\\"') + '""".trimIndent()'


def render() -> str:
    profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    sql = SQL_PATH.read_text(encoding="utf-8")
    chunks = [x.strip() for x in sql.split(MARKER)]
    preamble = chunks.pop(0).strip()
    if preamble != "PRAGMA foreign_keys = ON;":
        raise SystemExit("unexpected SQL preamble")
    statements = [chunk for chunk in chunks if chunk]
    if not statements:
        raise SystemExit("no SQL statements")
    profile_sha = hashlib.sha256(canonical(profile)).hexdigest()
    sql_sha = hashlib.sha256(sql.encode("utf-8")).hexdigest()
    rendered = ",\n".join("        " + kotlin_string(statement) for statement in statements)
    return f'''// generated; do not edit
package com.a620.tablet.training

object GeneratedRuntimeStoreSchema {{
    const val PROFILE = "{profile['profile']}"
    const val PROFILE_SHA256 = "{profile_sha}"
    const val SQL_SHA256 = "{sql_sha}"
    const val VERSION = {profile['schemaVersion']}
    const val DATABASE_NAME = "{profile['databaseName']}"
    const val CROSS_REBOOT_RETRY_CLOCK = "{profile['clockPolicy']['crossRebootRetryClock']}"
    val STATEMENTS: List<String> = listOf(
{rendered}
    )
}}
'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = render()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != content:
            raise SystemExit(f"generated Android controller store schema stale: {OUTPUT}")
        print("ANDROID_CONTROLLER_STORE_GENERATION_CHECK_PASS")
        return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(content, encoding="utf-8", newline="\n")
    print("ANDROID_CONTROLLER_STORE_GENERATION_PASS")


if __name__ == "__main__":
    main()
