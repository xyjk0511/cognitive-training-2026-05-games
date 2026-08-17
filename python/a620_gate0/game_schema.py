from __future__ import annotations
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
MAP = {
    "CATCH_LIGHT": ROOT / "games/catch-light/schemas",
    "SIGNAL_STATION": ROOT / "games/signal-station/schemas",
}

class GameSchemaError(ValueError):
    pass

def _validate(instance: object, path: Path) -> None:
    schema = json.loads(path.read_text(encoding="utf-8"))
    errors = sorted(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(instance), key=lambda e: list(e.path))
    if errors:
        raise GameSchemaError("; ".join(error.message for error in errors[:10]))

def validate_game_specific_payload(payload: dict) -> None:
    game_code = payload["gameCode"]
    if game_code not in MAP:
        raise GameSchemaError(f"unsupported gameCode: {game_code}")
    schema_root = MAP[game_code]
    for batch in payload["eligibleBatches"]:
        _validate(batch["gameBatchMetrics"], schema_root / "game_batch_metrics.schema.json")
    _validate(payload["gameMetrics"], schema_root / "game_metrics.schema.json")
