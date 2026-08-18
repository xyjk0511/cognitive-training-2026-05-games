#!/usr/bin/env python3
"""Validate Signal Station schemas, generated assets, and canonical evidence."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable

from jsonschema import Draft202012Validator

from a620_gate0.canonical import canonical_sha256
from a620_gate0.game_schema import validate_game_config, validate_game_specific_payload
from a620_gate0.schema import validate_schema

ROOT = Path(__file__).resolve().parents[2]
GAME_ROOT = ROOT / "games" / "signal-station"
PACKAGE_ROOT = ROOT / "packages" / "signal-station" / "content"
SCHEMA_ROOT = GAME_ROOT / "schemas"
LEVELS = [1, 7, 67, 79, 90, 96]
BLOCKABLE_LEVELS = [2, 6, 8, 66, 68, 78, 80, 89, 91, 95]
GENERATOR_VERSION = "signal-station-gen-1.2.1-r2"
CONTENT_VERSION = "signal-station-six-slice-1.2.1-r2"
PACKAGE_VERSION = "1.2.1-r2"
GOLDEN_VERSION = "A620-SS-GOLDEN-1.2.1-r2"
SCHEMA_IDS = {
    "game_config.schema.json": "urn:a620:signal-station:config:1.2.1",
    "game_batch_metrics.schema.json": "urn:a620:signal-station:batch-metrics:1.2.1",
    "game_metrics.schema.json": "urn:a620:signal-station:game-metrics:1.2.1",
    "partial_metrics.schema.json": "urn:a620:signal-station:partial-metrics:1.2.1",
}
TIMING_LIFECYCLE_MS = {"A": 2900, "C": 2600, "H": 2300}
TIMING_DOUBLE_WINDOW_MS = {"A": 1200, "C": 1100, "H": 1000}


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def validator(name: str) -> Draft202012Validator:
    schema = load(SCHEMA_ROOT / name)
    if schema.get("$id") != SCHEMA_IDS[name]:
        raise AssertionError(f"{name}: schema identity mismatch")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def require_rejected(instance: Any, target: Draft202012Validator, message: str) -> None:
    if not list(target.iter_errors(instance)):
        raise AssertionError(message)


def require_semantic_rejected(action: Callable[[], None], message: str) -> None:
    try:
        action()
    except AssertionError:
        return
    raise AssertionError(message)


def validate_batch_semantics(metrics: dict[str, Any], context: str) -> None:
    h, t, f, d = (metrics[name] for name in ("H", "T", "F", "D"))
    if h > t or f > d:
        raise AssertionError(f"{context}: H/T or F/D relation is invalid")
    completed = metrics["completedDoubleCount"]
    timed_out = metrics["timedOutDoubleCount"]
    double_count = metrics["doubleCount"]
    if completed + timed_out != double_count:
        raise AssertionError(f"{context}: closed double outcomes do not cover all ×2 instances")
    if metrics["doubleIntervalCount"] != completed:
        raise AssertionError(f"{context}: completed ×2 count differs from interval count")

    reaction_count = metrics["reactionTimeCount"]
    reaction_total = metrics["reactionTimeTotalMs"]
    reaction_min = metrics["reactionTimeMinMs"]
    reaction_max = metrics["reactionTimeMaxMs"]
    if not h <= reaction_count <= t:
        raise AssertionError(f"{context}: reaction count must contain every hit and no more than presented targets")
    if reaction_count == 0:
        if reaction_total != 0 or reaction_min is not None or reaction_max is not None:
            raise AssertionError(f"{context}: empty reaction summary is inconsistent")
    else:
        if reaction_min is None or reaction_max is None or reaction_min > reaction_max:
            raise AssertionError(f"{context}: reaction min/max are inconsistent")
        if not reaction_min * reaction_count <= reaction_total <= reaction_max * reaction_count:
            raise AssertionError(f"{context}: reaction total is outside min/max bounds")
        lifecycle = TIMING_LIFECYCLE_MS[metrics["timingProfile"]]
        if reaction_max >= lifecycle:
            raise AssertionError(f"{context}: reaction occurs outside the half-open signal lifecycle")

    interval_count = metrics["doubleIntervalCount"]
    interval_total = metrics["doubleIntervalTotalMs"]
    if interval_count == 0 and interval_total != 0:
        raise AssertionError(f"{context}: empty double-interval summary has a non-zero total")
    if interval_count:
        max_gap = TIMING_DOUBLE_WINDOW_MS[metrics["timingProfile"]] - 1
        if interval_total > interval_count * max_gap:
            raise AssertionError(f"{context}: double interval total exceeds the half-open window")


def validate_partial_semantics(metrics: dict[str, Any], context: str) -> None:
    if metrics["H"] > metrics["presentedTargetCount"]:
        raise AssertionError(f"{context}: partial H exceeds presented targets")
    if metrics["F"] > metrics["presentedDistractorCount"]:
        raise AssertionError(f"{context}: partial F exceeds presented distractors")
    accounted_targets = metrics["H"] + metrics["waitingDoubleCount"] + metrics["timedOutTargetCount"]
    if accounted_targets > metrics["presentedTargetCount"]:
        raise AssertionError(f"{context}: partial target states exceed presented targets")
    if metrics["completedDoubleCount"] > metrics["H"]:
        raise AssertionError(f"{context}: completed ×2 count exceeds total hits")
    if metrics["waveOrdinal"] == 0 and (
        metrics["presentedTargetCount"] != 0 or metrics["presentedDistractorCount"] != 0
    ):
        raise AssertionError(f"{context}: waveOrdinal 0 cannot contain presented instances")


def validate_game_metrics_semantics(metrics: dict[str, Any], context: str) -> None:
    if metrics["totalH"] > metrics["totalT"] or metrics["totalF"] > metrics["totalD"]:
        raise AssertionError(f"{context}: session H/T or F/D relation is invalid")
    if not metrics["totalH"] <= metrics["reactionTimeCount"] <= metrics["totalT"]:
        raise AssertionError(f"{context}: session reaction count is inconsistent")
    if metrics["generatedBatchCount"] != metrics["eligibleBatchCount"] + metrics["incompleteBatchCount"]:
        raise AssertionError(f"{context}: generated batch count is inconsistent")
    if metrics["generatedWaveCount"] != metrics["generatedBatchCount"] * 8:
        raise AssertionError(f"{context}: every generated batch must contain eight generated waves")

    count = metrics["reactionTimeCount"]
    total = metrics["reactionTimeTotalMs"]
    minimum = metrics["reactionTimeMinMs"]
    maximum = metrics["reactionTimeMaxMs"]
    if count == 0:
        if total != 0 or minimum is not None or maximum is not None:
            raise AssertionError(f"{context}: empty session reaction summary is inconsistent")
    elif minimum is None or maximum is None or minimum > maximum or not minimum * count <= total <= maximum * count:
        raise AssertionError(f"{context}: session reaction summary is inconsistent")

    blocked = metrics["verticalSliceCoverageBlocked"]
    reason = metrics["verticalSliceCoverageBlockReason"]
    level = metrics["verticalSliceBlockedLevel"]
    ordinal = metrics["verticalSliceBlockedAfterBatchOrdinal"]
    if blocked:
        if reason != "LEVEL_NOT_IMPLEMENTED" or level not in BLOCKABLE_LEVELS or ordinal is None:
            raise AssertionError(f"{context}: vertical-slice coverage block is inconsistent")
        if ordinal > metrics["eligibleBatchCount"] or metrics["incompleteBatchCount"] != 0:
            raise AssertionError(f"{context}: coverage block must follow an eligible batch and leave no partial batch")
    elif reason is not None or level is not None or ordinal is not None:
        raise AssertionError(f"{context}: unblocked session contains block details")


def validate_result_semantics(
    payload: dict[str, Any],
    context: str,
    batch_validator: Draft202012Validator,
    partial_validator: Draft202012Validator,
    metrics_validator: Draft202012Validator,
) -> None:
    validate_schema(payload, "a620_training_game_payload.schema.json")
    validate_game_specific_payload(payload)

    batches = payload["eligibleBatches"]
    partials = payload["incompleteBatchAudit"]
    metrics = payload["gameMetrics"]
    metrics_validator.validate(metrics)
    validate_game_metrics_semantics(metrics, context)

    if payload["gameCode"] != "SIGNAL_STATION" or payload["gamePayloadVersion"] != "A620-GP-1.1":
        raise AssertionError(f"{context}: outer game identity mismatch")
    if payload["actualTrainingMs"] != 300000 or payload["plannedBatchCount"] != 8:
        raise AssertionError(f"{context}: formal session duration/count mismatch")
    if payload["eligibleBatchCount"] != len(batches) or metrics["eligibleBatchCount"] != len(batches):
        raise AssertionError(f"{context}: eligible count differs between payload, metrics, and array")
    if metrics["incompleteBatchCount"] != len(partials):
        raise AssertionError(f"{context}: incomplete count differs between metrics and array")
    if len(partials) > 1:
        raise AssertionError(f"{context}: more than one incomplete audit")

    for expected_ordinal, batch in enumerate(batches, start=1):
        if batch["batchOrdinal"] != expected_ordinal or batch["closedAtActiveMs"] != expected_ordinal * 37500:
            raise AssertionError(f"{context}: eligible batch ordering/boundary mismatch")
        projection = dict(batch)
        batch_hash = projection.pop("batchPayloadSha256")
        if batch_hash != canonical_sha256(projection):
            raise AssertionError(f"{context}: eligible batch {expected_ordinal} hash mismatch")
        batch_validator.validate(batch["gameBatchMetrics"])
        validate_batch_semantics(batch["gameBatchMetrics"], f"{context}/batch-{expected_ordinal}")

    for index, partial in enumerate(partials, start=1):
        partial_validator.validate(partial["partialMetrics"])
        validate_partial_semantics(partial["partialMetrics"], f"{context}/partial-{index}")
        if partial["cutoffReason"] != "DEADLINE" or partial["cutoffAtActiveMs"] != 300000:
            raise AssertionError(f"{context}: incomplete audit cutoff mismatch")

    aggregate_fields = {"totalH": "H", "totalT": "T", "totalF": "F", "totalD": "D"}
    for total_name, batch_name in aggregate_fields.items():
        expected = sum(item["gameBatchMetrics"][batch_name] for item in batches)
        if metrics[total_name] != expected:
            raise AssertionError(f"{context}: {total_name} aggregate mismatch")
    if payload["sessionRawScore"] != sum(item["batchScore"] for item in batches):
        raise AssertionError(f"{context}: session raw-score aggregate mismatch")
    if payload["sessionRawScoreMax"] != 800:
        raise AssertionError(f"{context}: session raw-score maximum mismatch")

    expected_end = batches[-1]["levelAfter"] if batches else payload["sessionStartLevel"]
    if payload["sessionEndLevel"] != expected_end or payload["nextStartLevel"] != expected_end:
        raise AssertionError(f"{context}: session end/next level mismatch")
    expected_highest_presented = max(
        [payload["sessionStartLevel"], *(batch["levelBefore"] for batch in batches)]
    )
    if payload["sessionHighestPresentedLevel"] != expected_highest_presented:
        raise AssertionError(f"{context}: highest presented level mismatch")
    passed = [batch["levelBefore"] for batch in batches if batch["resultZone"] == "UPGRADE"]
    expected_highest_passed = max(passed) if passed else None
    if payload["sessionHighestPassedLevel"] != expected_highest_passed:
        raise AssertionError(f"{context}: highest passed level mismatch")

    if metrics["verticalSliceCoverageBlocked"]:
        if not batches:
            raise AssertionError(f"{context}: coverage block without an eligible batch")
        if metrics["verticalSliceBlockedAfterBatchOrdinal"] != batches[-1]["batchOrdinal"]:
            raise AssertionError(f"{context}: coverage block is not attached to the last closed batch")
        if metrics["verticalSliceBlockedLevel"] != batches[-1]["levelAfter"]:
            raise AssertionError(f"{context}: coverage blocked level differs from the last transition")
        if payload["sessionEndLevel"] != metrics["verticalSliceBlockedLevel"] or partials:
            raise AssertionError(f"{context}: coverage result outer fields are inconsistent")
        if any(batch["levelBefore"] == metrics["verticalSliceBlockedLevel"] for batch in batches):
            raise AssertionError(f"{context}: blocked level was incorrectly reported as presented")


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
    if config.get("generatorVersion") != GENERATOR_VERSION or config.get("contentVersion") != CONTENT_VERSION:
        raise AssertionError("runtime config revision identity mismatch")
    altered = copy.deepcopy(config)
    altered["durationMs"] = 299999
    require_rejected(altered, config_validator, "formal config schema accepted an altered duration")
    altered = copy.deepcopy(config)
    altered["unexpected"] = True
    require_rejected(altered, config_validator, "formal config schema accepted an extra property")

    valid_partial = {
        "waveOrdinal": 3,
        "presentedTargetCount": 7,
        "presentedDistractorCount": 3,
        "H": 4,
        "F": 1,
        "waitingDoubleCount": 1,
        "completedDoubleCount": 0,
        "timedOutTargetCount": 2,
        "activeElapsedInBatchMs": 10000,
    }
    partial_validator.validate({})
    partial_validator.validate(valid_partial)
    validate_partial_semantics(valid_partial, "valid partial fixture")
    require_rejected({"waveOrdinal": 9}, partial_validator, "partial schema accepted an out-of-range wave")
    require_rejected(dict(valid_partial, H=8), partial_validator, "partial schema accepted H above presented targets")
    require_semantic_rejected(
        lambda: validate_partial_semantics(dict(valid_partial, waitingDoubleCount=4), "invalid partial fixture"),
        "partial semantic verifier accepted over-accounted target states",
    )

    metrics_validator.validate({})
    if not list(batch_validator.iter_errors({})):
        raise AssertionError("eligible batch metrics must not accept an empty placeholder")

    invalid_batch = {
        "H": 11, "T": 10, "F": 0, "D": 0, "timingProfile": "A", "targetClassCount": 1,
        "similarityTier": 0, "directionCount": 1, "doubleCount": 0, "completedDoubleCount": 0,
        "timedOutDoubleCount": 0, "presentedWaveCount": 8, "reactionTimeCount": 10,
        "reactionTimeTotalMs": 10, "reactionTimeMinMs": 1, "reactionTimeMaxMs": 1,
        "doubleIntervalCount": 0, "doubleIntervalTotalMs": 0,
    }
    require_rejected(invalid_batch, batch_validator, "batch schema accepted H above T")
    invalid_double = dict(invalid_batch)
    invalid_double.update({
        "H": 14, "T": 20, "F": 3, "D": 10, "timingProfile": "H", "targetClassCount": 2,
        "similarityTier": 2, "directionCount": 4, "doubleCount": 4, "completedDoubleCount": 2,
        "timedOutDoubleCount": 1, "reactionTimeCount": 14, "reactionTimeTotalMs": 14,
        "doubleIntervalCount": 2, "doubleIntervalTotalMs": 2,
    })
    require_rejected(invalid_double, batch_validator, "batch schema accepted incomplete closed ×2 accounting")
    invalid_reaction_count = dict(invalid_double)
    invalid_reaction_count.update({
        "completedDoubleCount": 2, "timedOutDoubleCount": 2, "doubleIntervalCount": 2,
        "reactionTimeCount": 13,
    })
    require_rejected(invalid_reaction_count, batch_validator, "batch schema accepted reactionTimeCount below H")
    invalid_h_timing = dict(invalid_double)
    invalid_h_timing.update({
        "completedDoubleCount": 2, "timedOutDoubleCount": 2, "doubleIntervalCount": 2,
        "reactionTimeMaxMs": 2300, "reactionTimeTotalMs": 2300,
    })
    require_rejected(invalid_h_timing, batch_validator, "batch schema accepted an H-profile reaction at the half-open lifecycle end")

    runtime_hash = canonical_sha256(config)
    if golden.get("vectorVersion") != GOLDEN_VERSION or golden.get("generatorVersion") != GENERATOR_VERSION:
        raise AssertionError("golden vector revision identity mismatch")
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
        if vector["resultDraft"]["eligibleBatches"] != [vector["expectedBatch"]]:
            raise AssertionError(f"{vector['id']}: expected batch differs from result payload")
        validate_result_semantics(
            vector["resultDraft"], vector["id"], batch_validator, partial_validator, metrics_validator
        )

    coverage_vectors = golden.get("coverageBoundaryVectors", [])
    if [item.get("id") for item in coverage_vectors] != [
        "SIGNAL_STATION_COVERAGE_L1_TO_L2", "SIGNAL_STATION_COVERAGE_L96_TO_L95"
    ]:
        raise AssertionError("coverage-boundary golden vector identity/order mismatch")
    for vector in coverage_vectors:
        block = vector["coverageBlock"]
        if block != {
            "reason": "LEVEL_NOT_IMPLEMENTED",
            "blockedLevel": vector["blockedLevel"],
            "afterBatchOrdinal": vector["afterBatchOrdinal"],
        }:
            raise AssertionError(f"{vector['id']}: coverage block projection mismatch")
        plans = vector.get("plans", [])
        plan_hashes = vector.get("planSha256s", [])
        if len(plans) != vector["afterBatchOrdinal"] or len(plan_hashes) != len(plans):
            raise AssertionError(f"{vector['id']}: coverage plan count/hash count mismatch")
        for expected_ordinal, (plan, plan_hash) in enumerate(zip(plans, plan_hashes), start=1):
            if plan_hash != canonical_sha256(plan):
                raise AssertionError(f"{vector['id']}: coverage plan {expected_ordinal} hash mismatch")
            if plan["batchOrdinal"] != expected_ordinal or plan["sessionSeed"] != vector["sessionSeed"]:
                raise AssertionError(f"{vector['id']}: coverage plan identity mismatch")
        validate_result_semantics(
            vector["resultDraft"], vector["id"], batch_validator, partial_validator, metrics_validator
        )

    valid_coverage_metrics = copy.deepcopy(coverage_vectors[0]["resultDraft"]["gameMetrics"])
    metrics_validator.validate(valid_coverage_metrics)
    validate_game_metrics_semantics(valid_coverage_metrics, "valid coverage fixture")
    require_rejected(
        dict(valid_coverage_metrics, verticalSliceBlockedLevel=1),
        metrics_validator,
        "game metrics schema accepted an implemented level as a coverage block",
    )
    require_semantic_rejected(
        lambda: validate_game_metrics_semantics(
            dict(valid_coverage_metrics, verticalSliceBlockedAfterBatchOrdinal=2), "invalid coverage fixture"
        ),
        "game metrics semantic verifier accepted a block beyond eligible batches",
    )

    if config_path.read_bytes() != (PACKAGE_ROOT / "config" / "runtime-config.json").read_bytes():
        raise AssertionError("package runtime config is not byte-identical to the source asset")
    if golden_path.read_bytes() != (PACKAGE_ROOT / "golden-vectors" / "vertical-slices.json").read_bytes():
        raise AssertionError("package golden vectors are not byte-identical to the source asset")

    bundle_index = load(PACKAGE_ROOT / "bundle" / "index.json")
    if bundle_index.get("implementedLevels") != LEVELS or bundle_index.get("fullLevelSetStatus") != "HOLD":
        raise AssertionError("package bundle index does not declare the frozen vertical-slice scope")
    if bundle_index.get("verticalSliceTransitionPolicy") != "BLOCK_AND_AUDIT_UNIMPLEMENTED_LEVEL":
        raise AssertionError("package bundle index does not declare the fail-closed transition policy")
    expected_bundle_identity = {
        "packageVersion": PACKAGE_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "contentVersion": CONTENT_VERSION,
        "gameConfigSchemaId": SCHEMA_IDS["game_config.schema.json"],
        "gameBatchMetricsSchemaId": SCHEMA_IDS["game_batch_metrics.schema.json"],
        "gameMetricsSchemaId": SCHEMA_IDS["game_metrics.schema.json"],
        "partialMetricsSchemaId": SCHEMA_IDS["partial_metrics.schema.json"],
    }
    for key, expected in expected_bundle_identity.items():
        if bundle_index.get(key) != expected:
            raise AssertionError(f"package bundle index {key} mismatch")

    # The package-declared config schema identity must remain acceptable to the
    # frozen A620-TRC-1.1 validator. Generator/content revisions do not create
    # a new public schema identity inside this parallel worker.
    validate_game_config(
        "SIGNAL_STATION", bundle_index["gameConfigSchemaId"], config
    )

    manifest_base = load(ROOT / "packages" / "signal-station" / "manifest.base.json")
    if (
        manifest_base.get("packageVersion") != PACKAGE_VERSION
        or manifest_base.get("generatorVersion") != GENERATOR_VERSION
        or manifest_base.get("releaseSequence") != 3
    ):
        raise AssertionError("package manifest base does not identify the hardened W3 r2 release")

    print("SIGNAL_STATION_SCHEMA_ASSET_VERIFY_PASS")
    print(f"RUNTIME_CONFIG_SHA256={runtime_hash}")
    print(f"GENERATOR_VERSION={GENERATOR_VERSION}")
    print(f"PUBLIC_CONFIG_SCHEMA_ID={SCHEMA_IDS['game_config.schema.json']}")
    print("PUBLIC_PREPARE_CONFIG_VALIDATION=PASS")
    print(f"GOLDEN_REPRESENTATIVE_VECTOR_COUNT={len(golden['vectors'])}")
    print(f"GOLDEN_COVERAGE_BOUNDARY_VECTOR_COUNT={len(coverage_vectors)}")
    print("IMPLEMENTED_LEVELS=1,7,67,79,90,96")
    print("VERTICAL_SLICE_TRANSITION_POLICY=BLOCK_AND_AUDIT_UNIMPLEMENTED_LEVEL")


if __name__ == "__main__":
    main()
