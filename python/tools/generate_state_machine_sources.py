from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "contracts/normative/a620_runtime_state_machine_v1.1.json"
TS_TARGET = ROOT / "typescript/src/generated-state-machine.ts"
KT_TARGET = ROOT / "kotlin/src/main/kotlin/a620/GeneratedStateMachineContract.kt"


def _expanded_transitions(spec: dict) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()
    for transition in spec["transitions"]:
        for source in transition["from"]:
            key = (source, transition["input"])
            if key in seen:
                raise ValueError(f"duplicate state/input transition: {key}")
            seen.add(key)
            rows.append((source, transition["input"], transition["to"]))
    return sorted(rows)


def _typescript(spec: dict) -> str:
    transitions = _expanded_transitions(spec)
    non_mutating = spec["nonMutatingInputLegality"]
    lines = [
        "// Generated from contracts/normative/a620_runtime_state_machine_v1.1.json.",
        "// Do not edit by hand; run scripts/bootstrap_vectors.sh.",
        'import type { RuntimeState } from "./contracts.js";',
        "",
        "export const GENERATED_TRANSITIONS = new Map<string, RuntimeState>([",
    ]
    for source, input_name, target in transitions:
        lines.append(f'  ["{source}|{input_name}", "{target}"],')
    lines.extend([
        "]);",
        "",
        "export const GENERATED_NON_MUTATING = new Map<string, ReadonlySet<RuntimeState>>([",
    ])
    for input_name in sorted(non_mutating):
        states = ", ".join(f'"{state}"' for state in non_mutating[input_name])
        lines.append(f'  ["{input_name}", new Set<RuntimeState>([{states}])],')
    lines.extend([
        "]);",
        "",
        "export const GENERATED_TERMINAL_STATES = new Set<RuntimeState>([",
    ])
    for state in spec["terminalStates"]:
        lines.append(f'  "{state}",')
    lines.extend([
        "]);",
        "",
    ])
    return "\n".join(lines)


def _kotlin(spec: dict) -> str:
    transitions = _expanded_transitions(spec)
    non_mutating = spec["nonMutatingInputLegality"]
    lines = [
        "// Generated from contracts/normative/a620_runtime_state_machine_v1.1.json.",
        "// Do not edit by hand; run scripts/bootstrap_vectors.sh.",
        "package a620",
        "",
        "object GeneratedStateMachineContract {",
        "    val transitions: Map<Pair<RuntimeState, RuntimeInput>, RuntimeState> = mapOf(",
    ]
    for source, input_name, target in transitions:
        lines.append(
            f"        (RuntimeState.{source} to RuntimeInput.{input_name}) to RuntimeState.{target},"
        )
    lines.extend([
        "    )",
        "",
        "    val nonMutating: Map<RuntimeInput, Set<RuntimeState>> = mapOf(",
    ])
    for input_name in sorted(non_mutating):
        states = ", ".join(f"RuntimeState.{state}" for state in non_mutating[input_name])
        lines.append(f"        RuntimeInput.{input_name} to setOf({states}),")
    lines.extend([
        "    )",
        "",
        "    val terminalStates: Set<RuntimeState> = setOf(",
    ])
    for state in spec["terminalStates"]:
        lines.append(f"        RuntimeState.{state},")
    lines.extend([
        "    )",
        "}",
        "",
    ])
    return "\n".join(lines)


def _write_or_check(path: Path, expected: str, check: bool) -> None:
    if check:
        actual = path.read_text(encoding="utf-8") if path.exists() else ""
        if actual != expected:
            raise SystemExit(f"generated state-machine source is stale: {path.relative_to(ROOT)}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(expected, encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    spec = json.loads(SOURCE.read_text(encoding="utf-8"))
    _write_or_check(TS_TARGET, _typescript(spec), args.check)
    _write_or_check(KT_TARGET, _kotlin(spec), args.check)


if __name__ == "__main__":
    main()
