#!/usr/bin/env python3
"""Validate Signal Station schemas, generated assets, and canonical evidence."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from a620_gate0.canonical import canonical_sha256
from a620_gate0.game_schema import validate_game_specific_payload
from a620_gate0.schema import validate_schema

ROOT = Path(__file__).resolve().parents[2]
GAME_ROOT = ROOT / "games" / "signal-station"
PACKAGE_ROOT = ROOT / "packages" / "signal-station" / "content"
SCHEMA_ROOT = GAME_ROOT / "schemas"
LEVELS = [1, 7, 67, 79, 90, 96]


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def validator(name: str) -> Draft202012Validator:
    schema = load(SCHEMA_ROOT / name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def require_rejected(instance: Any, target: Draft202012Validator, message: str) -> None:
    if not list(target.iter_errors(instance)):
        raise AssertionError(message)


def main() -> None:
    config_path = GAME_ROOT / "configs" / "vertical-slices" / "runtime-config.json"
    golden_path = GAME_ROOT / "golden-vectors" / "vertical-slices.json"
    config = load(config_path)
    golden = load(golden_path)

    config_validator = validator("game_config.schema.json")
    batch_validator = validator("game_batch_metrics.schema.json")
    partial_validator = validator("partial_metrics.schema.json")
    metrics_validator = validator("game_metrics.schema.json")

    config_validator.validate(config)
    config_validator.validate({})
    altered = copy.deepcopy(config)
    altered["durationMs"] = 299999
    require_rejected(altered, config_validator, "formal config schema accepted an altered duration")
    altered = copy.deepcopy(config)
    altered["unexpected"] = True
    require_rejected(altered, config_validator, "formal config schema accepted an extra property")

    partial_validator.validate({})
    partial_validator.validate({
        "waveOrdinal": 3,
        "presentedTargetCount": 7,
        "presentedDistractorCount": 3,
        "H": 4,
        "F": 1,
        "waitingDoubleCount": 1,
        "completedDoubleCount": 0,
        "timedOutTargetCount": 2,
        "activeElapsedInBatchMs": 10000,
    })
    require_rejected({"waveOrdinal": 9}, partial_validator, "partial schema accepted an out-of-range wave")
    metrics_validator.validate({})
    batch_validator_errors = list(batch_validator.iter_errors({}))
    if not batch_validator_errors:
        raise AssertionError("eligible batch metrics must not accept an empty placeholder")

    runtime_hash = canonical_sha256(config)
    if golden.get("runtimeConfigHash") != runtime_hash:
        raise AssertionError("golden runtimeConfigHash does not match committed config")
    if [item.get("level") for item in golden.get("vectors", [])] != LEVELS:
        raise AssertionError("golden vector level set/order mismatch")

    for vector in golden["vectors"]:
        plan = vector["plan"]
        if vector["planSha256"] != canonical_sha256(plan):
            raise AssertionError(f"{vector['id']}: plan hash mismatch")
        if plan["level"] != vector["level"] or plan["sessionSeed"] != vector["sessionSeed"]:
            raise AssertionError(f"{vector['id']}: plan identity mismatch")
        if len(plan["waves"]) != 8:
            raise AssertionError(f"{vector['id']}: plan does not contain eight waves")

        expected = vector["expectedBatch"]
        payload = vector["resultDraft"]
        if payload["eligibleBatches"] != [expected]:
            raise AssertionError(f"{vector['id']}: expected batch differs from result payload")
        projection = dict(expected)
        batch_hash = projection.pop("batchPayloadSha256")
        if batch_hash != canonical_sha256(projection):
            raise AssertionError(f"{vector['id']}: eligible batch hash mismatch")
        batch_validator.validate(expected["gameBatchMetrics"])
        metrics_validator.validate(payload["gameMetrics"])
        validate_schema(payload, "a620_training_game_payload.schema.json")
        validate_game_specific_payload(payload)
        metrics = payload["gameMetrics"]
        batches = payload["eligibleBatches"]
        if metrics["totalH"] != sum(item["gameBatchMetrics"]["H"] for item in batches):
            raise AssertionError(f"{vector['id']}: session H aggregate mismatch")
        if metrics["totalT"] != sum(item["gameBatchMetrics"]["T"] for item in batches):
            raise AssertionError(f"{vector['id']}: session T aggregate mismatch")
        if metrics["totalF"] != sum(item["gameBatchMetrics"]["F"] for item in batches):
            raise AssertionError(f"{vector['id']}: session F aggregate mismatch")
        if metrics["totalD"] != sum(item["gameBatchMetrics"]["D"] for item in batches):
            raise AssertionError(f"{vector['id']}: session D aggregate mismatch")
        if payload["sessionRawScore"] != sum(item["batchScore"] for item in batches):
            raise AssertionError(f"{vector['id']}: session raw-score aggregate mismatch")

    if config_path.read_bytes() != (PACKAGE_ROOT / "config" / "runtime-config.json").read_bytes():
        raise AssertionError("package runtime config is not byte-identical to the source asset")
    if golden_path.read_bytes() != (PACKAGE_ROOT / "golden-vectors" / "vertical-slices.json").read_bytes():
        raise AssertionError("package golden vectors are not byte-identical to the source asset")
    bundle_index = load(PACKAGE_ROOT / "bundle" / "index.json")
    if bundle_index.get("implementedLevels") != LEVELS or bundle_index.get("fullLevelSetStatus") != "HOLD":
        raise AssertionError("package bundle index does not declare the frozen vertical-slice scope")
    manifest_base = load(ROOT / "packages" / "signal-station" / "manifest.base.json")
    if manifest_base.get("generatorVersion") != "signal-station-gen-1.2.1" or manifest_base.get("releaseSequence") != 2:
        raise AssertionError("package manifest base does not identify the W3 generator release")

    print("SIGNAL_STATION_SCHEMA_ASSET_VERIFY_PASS")
    print(f"RUNTIME_CONFIG_SHA256={runtime_hash}")
    print(f"GOLDEN_VECTOR_COUNT={len(golden['vectors'])}")
    print("IMPLEMENTED_LEVELS=1,7,67,79,90,96")


if __name__ == "__main__":
    main()
