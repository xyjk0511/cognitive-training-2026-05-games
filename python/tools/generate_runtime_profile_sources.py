from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NORM = ROOT / "contracts/normative"
PY_TARGET = ROOT / "python/a620_gate0/generated_profiles.py"
TS_TARGET = ROOT / "typescript/src/generated-runtime-profiles.ts"
KT_TARGET = ROOT / "kotlin/src/main/kotlin/a620/GeneratedRuntimeProfiles.kt"


def load(name: str) -> dict:
    return json.loads((NORM / name).read_text(encoding="utf-8"))


def values() -> dict[str, object]:
    resource = load("a620_json_resource_profile_v1.1.json")
    frame = load("a620_ipc_frame_profile_v1.1.json")
    delivery = load("a620_delivery_reliability_profile_v1.1.json")
    watchdog = load("a620_runtime_watchdog_profile_v1.1.json")
    audit = load("a620_runtime_audit_chain_profile_v1.1.json")
    return {
        "JSON_MAX_DEPTH": resource["maxDepth"],
        "JSON_MAX_TOTAL_NODES": resource["maxTotalNodes"],
        "JSON_MAX_OBJECT_MEMBERS": resource["maxObjectMembers"],
        "JSON_MAX_ARRAY_ITEMS": resource["maxArrayItems"],
        "JSON_MAX_STRING_UTF8_BYTES": resource["maxStringUtf8Bytes"],
        "JSON_MAX_OBJECT_KEY_UTF8_BYTES": resource["maxObjectKeyUtf8Bytes"],
        "JSON_MAX_TOTAL_STRING_UTF8_BYTES": resource["maxTotalStringUtf8Bytes"],
        "IPC_FRAME_HEADER_BYTES": frame["headerBytes"],
        "IPC_FRAME_MIN_PAYLOAD_BYTES": frame["minimumPayloadBytes"],
        "IPC_FRAME_MAX_PAYLOAD_BYTES": frame["maximumPayloadBytes"],
        "IPC_FRAME_MAX_FEED_CHUNK_BYTES": frame["maximumFeedChunkBytes"],
        "DELIVERY_RETRY_DELAYS_MS": delivery["retryDelayMsByCompletedAttempt"],
        "DELIVERY_RETRY_CAP_MS": delivery["retryDelayCapMs"],
        "DELIVERY_MAX_SEEN_MESSAGE_IDS_PER_RUNTIME": delivery["maximumSeenMessageIdsPerRuntime"],
        "DELIVERY_MAX_PENDING_PER_RUNTIME": delivery["maximumPendingMessagesPerRuntime"],
        "DELIVERY_MAX_PENDING_BYTES_PER_RUNTIME": delivery["maximumPendingCanonicalBytesPerRuntime"],
        "DELIVERY_RESPONSE_OBLIGATIONS": delivery["responseObligations"],
        "DELIVERY_RETAIN_UNTIL_RESULT_COMMITTED": delivery["retainUntilResultCommitted"],
        "WATCHDOG_TIMEOUTS_MS": watchdog["timeoutsMs"],
        "WATCHDOG_SNAPSHOT_VERSION": watchdog["snapshotVersion"],
        "AUDIT_CHAIN_PROFILE_ID": audit["profile"],
        "AUDIT_CHAIN_GENESIS_SHA256": audit["genesisSha256"],
        "AUDIT_CHAIN_ENTRY_PROJECTION": audit["entryProjection"],
        "AUDIT_CHAIN_MIGRATION_KEY": audit["migrationMarkerKey"],
        "AUDIT_CHAIN_MIGRATION_VALUE": audit["migrationMarkerValue"],
    }


def python_source(data: dict[str, object]) -> str:
    lines = [
        "# Generated from contracts/normative A620 runtime profiles.",
        "# Do not edit by hand; run scripts/bootstrap_vectors.sh.",
        "from __future__ import annotations",
        "",
    ]
    for key, value in data.items():
        lines.append(f"{key} = {value!r}")
    lines.append("")
    return "\n".join(lines)


def ts_literal(value: object, *, top_level: bool = False) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        body = ", ".join(ts_literal(item) for item in value)
        return "[" + body + "]" + (" as const" if top_level else "")
    if isinstance(value, dict):
        body = ",\n".join(
            f"  {json.dumps(k, ensure_ascii=False)}: {ts_literal(v)}" for k, v in value.items()
        )
        return "Object.freeze({\n" + body + "\n})"
    raise TypeError(f"unsupported TypeScript literal type: {type(value)!r}")


def typescript_source(data: dict[str, object]) -> str:
    lines = [
        "// Generated from contracts/normative A620 runtime profiles.",
        "// Do not edit by hand; run scripts/bootstrap_vectors.sh.",
        "",
    ]
    for key, value in data.items():
        lines.append(f"export const {key} = {ts_literal(value, top_level=True)};")
    lines.append("")
    return "\n".join(lines)


def kt_name(key: str) -> str:
    return "".join(part.title() for part in key.lower().split("_"))


def kotlin_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def kotlin_source(data: dict[str, object]) -> str:
    lines = [
        "// Generated from contracts/normative A620 runtime profiles.",
        "// Do not edit by hand; run scripts/bootstrap_vectors.sh.",
        "package a620",
        "",
        "object GeneratedRuntimeProfiles {",
    ]
    for key, value in data.items():
        name = kt_name(key)
        if isinstance(value, str):
            lines.append(f"    const val {name}: String = {kotlin_string(value)}")
        elif isinstance(value, list) and all(isinstance(item, int) and not isinstance(item, bool) for item in value):
            body = ", ".join(f"{item}L" for item in value)
            lines.append(f"    val {name} = longArrayOf({body})")
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            body = ", ".join(kotlin_string(item) for item in value)
            lines.append(f"    val {name}: List<String> = listOf({body})")
        elif isinstance(value, dict) and all(isinstance(item, int) and not isinstance(item, bool) for item in value.values()):
            body = ", ".join(f'{kotlin_string(k)} to {v}L' for k, v in value.items())
            lines.append(f"    val {name}: Map<String, Long> = mapOf({body})")
        elif isinstance(value, dict) and all(
            isinstance(item, list) and all(isinstance(part, str) for part in item)
            for item in value.values()
        ):
            body = ", ".join(
                f'{kotlin_string(k)} to listOf(' + ", ".join(kotlin_string(part) for part in v) + ")"
                for k, v in value.items()
            )
            lines.append(f"    val {name}: Map<String, List<String>> = mapOf({body})")
        elif isinstance(value, int) and not isinstance(value, bool):
            lines.append(f"    const val {name}: Int = {value}")
        else:
            raise TypeError(f"unsupported Kotlin profile value for {key}: {value!r}")
    lines.extend(["}", ""])
    return "\n".join(lines)


def write_or_check(path: Path, expected: str, check: bool) -> None:
    if check:
        actual = path.read_text(encoding="utf-8") if path.exists() else ""
        if actual != expected:
            raise SystemExit(f"generated runtime profile source is stale: {path.relative_to(ROOT)}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(expected, encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = values()
    write_or_check(PY_TARGET, python_source(data), args.check)
    write_or_check(TS_TARGET, typescript_source(data), args.check)
    write_or_check(KT_TARGET, kotlin_source(data), args.check)


if __name__ == "__main__":
    main()
