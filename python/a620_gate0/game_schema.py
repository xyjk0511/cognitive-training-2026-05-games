from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
GAME_PROFILES = {
    "CATCH_LIGHT": {
        "root": ROOT / "games/catch-light/schemas",
        "configSchemaId": "urn:a620:catch-light:config:1.5",
    },
    "SIGNAL_STATION": {
        "root": ROOT / "games/signal-station/schemas",
        "configSchemaId": "urn:a620:signal-station:config:1.2.1",
    },
}


class GameSchemaError(ValueError):
    pass


def _validate(instance: object, path: Path) -> None:
    schema = json.loads(path.read_text(encoding="utf-8"))
    errors = sorted(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(instance),
        key=lambda error: list(error.path),
    )
    if errors:
        messages = []
        for error in errors[:10]:
            location = "$" + "".join(f"[{part!r}]" for part in error.path)
            messages.append(f"{location}: {error.message}")
        raise GameSchemaError("; ".join(messages))


def _profile(game_code: str) -> dict[str, Any]:
    try:
        return GAME_PROFILES[game_code]
    except KeyError as exc:
        raise GameSchemaError(f"unsupported gameCode: {game_code}") from exc


def validate_game_config(game_code: str, schema_id: str, config: dict[str, Any]) -> None:
    profile = _profile(game_code)
    if schema_id != profile["configSchemaId"]:
        raise GameSchemaError(
            f"gameConfigSchemaId mismatch for {game_code}: expected {profile['configSchemaId']}, got {schema_id}"
        )
    _validate(config, profile["root"] / "game_config.schema.json")


def validate_game_specific_payload(payload: dict[str, Any]) -> None:
    profile = _profile(payload["gameCode"])
    schema_root: Path = profile["root"]

    for batch in payload["eligibleBatches"]:
        metrics = batch["gameBatchMetrics"]
        _validate(metrics, schema_root / "game_batch_metrics.schema.json")
        if metrics["H"] > metrics["T"]:
            raise GameSchemaError("H cannot exceed T")
        if metrics["F"] > metrics["D"]:
            raise GameSchemaError("F cannot exceed D")

    for audit in payload["incompleteBatchAudit"]:
        _validate(audit["partialMetrics"], schema_root / "partial_metrics.schema.json")

    _validate(payload["gameMetrics"], schema_root / "game_metrics.schema.json")
