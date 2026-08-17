from __future__ import annotations
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "contracts" / "schemas"
FORMAT_CHECKER = FormatChecker()

def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / name).read_text(encoding="utf-8"))

def validate_schema(instance: object, name: str) -> None:
    schema = load_schema(name)
    validator = Draft202012Validator(schema, format_checker=FORMAT_CHECKER)
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
    if errors:
        messages = []
        for error in errors[:20]:
            path = "$" + "".join(f"[{p!r}]" for p in error.path)
            messages.append(f"{path}: {error.message}")
        raise ValueError("Schema validation failed:\n" + "\n".join(messages))
