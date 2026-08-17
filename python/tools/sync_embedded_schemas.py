from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "contracts/schemas"


def load(name: str) -> dict[str, Any]:
    return json.loads((SCHEMAS / name).read_text(encoding="utf-8"))


def write(name: str, value: dict[str, Any]) -> None:
    (SCHEMAS / name).write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def embeddable(schema: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(schema)
    result.pop("$schema", None)
    result.pop("$id", None)
    return result


def main() -> None:
    payload = embeddable(load("a620_training_game_payload.schema.json"))

    runtime = load("a620_training_runtime_message.schema.json")
    result_ready_branches = [
        branch
        for branch in runtime["oneOf"]
        if branch.get("properties", {}).get("messageType", {}).get("const") == "RESULT_READY"
    ]
    if len(result_ready_branches) != 1:
        raise RuntimeError("expected exactly one RESULT_READY branch")
    result_ready_branches[0]["properties"]["payload"]["properties"]["gamePayload"] = deepcopy(payload)
    write("a620_training_runtime_message.schema.json", runtime)

    formal = load("a620_formal_training_result.schema.json")
    formal["properties"]["gamePayload"] = deepcopy(payload)
    write("a620_formal_training_result.schema.json", formal)


if __name__ == "__main__":
    main()
