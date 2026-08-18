from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT / "android/app/schemas/runtime_store_v1_to_v4.sql"
OUTPUT = ROOT / "android/app/src/main/java/com/a620/tablet/training/GeneratedRuntimeStoreMigration.kt"
MARKER = "-- A620_MIGRATION_STATEMENT"


def kotlin_string(value: str) -> str:
    return '"""' + value.replace('"""', '\\"\\"\\"') + '""".trimIndent()'


def render() -> str:
    sql = SQL_PATH.read_text(encoding="utf-8")
    chunks = [chunk.strip() for chunk in sql.split(MARKER)]
    preamble = chunks.pop(0)
    if "data-preserving archive migration" not in preamble:
        raise SystemExit("unexpected migration preamble")
    statements = [chunk for chunk in chunks if chunk]
    if len(statements) != 7:
        raise SystemExit(f"expected 7 migration statements, found {len(statements)}")
    rendered = ",\n".join("        " + kotlin_string(statement) for statement in statements)
    sha = hashlib.sha256(sql.encode("utf-8")).hexdigest()
    return f'''// generated; do not edit
package com.a620.tablet.training

object GeneratedRuntimeStoreMigration {{
    const val FROM_VERSION = 1
    const val TO_VERSION = 4
    const val MIGRATION_ID = "A620-ACDS-MIGRATION-1-TO-4-ARCHIVE"
    const val SQL_SHA256 = "{sha}"
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
            raise SystemExit(f"generated Android migration stale: {OUTPUT}")
        print("ANDROID_CONTROLLER_STORE_MIGRATION_GENERATION_CHECK_PASS")
        return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(content, encoding="utf-8", newline="\n")
    print("ANDROID_CONTROLLER_STORE_MIGRATION_GENERATION_PASS")


if __name__ == "__main__":
    main()
