#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import struct
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from a620_gate0.canonical import canonical_sha256  # noqa: E402
from a620_gate0.game_schema import validate_game_config  # noqa: E402
from a620_gate0.result_validator import validate_game_payload  # noqa: E402

FRUITS = {
    "APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE",
    "WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO",
}
EXPECTED_LEVELS = [1, 28, 67, 102, 120]
CONFIG_SCHEMA_ID = "urn:a620:catch-light:config:1.5"
CONFIG_SET_ID = "catch-light-v1.5-w2-vertical-slices"
SOURCE_WORKBOOK_NAME = "捕光行动-120级数值设计-v1.4.xlsx"
SOURCE_WORKBOOK_SHA256 = "592a6313bb3f308aa63d5e1313db98b617dfc735ac8fd61efb7c7f06112d716d"
SOURCE_REQUIREMENT_SHA256 = "1ff1d38470aead2270d6b237b3cda2a21a7540174420252a5bda8b242bfb425c"
PUBLIC_RULES_SHA256 = "c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794"
TIMING_BY_BAND = {
    "A": (3300, 2900, 350, 650),
    "C": (3200, 2800, 450, 750),
    "H": (3100, 2700, 550, 850),
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"{path}: invalid PNG signature")
    require(data[12:16] == b"IHDR", f"{path}: missing PNG IHDR")
    return struct.unpack(">II", data[16:24])


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fnv1a32(value: str) -> int:
    state = 0x811C9DC5
    for byte in value.encode("utf-8"):
        state ^= byte
        state = (state * 0x01000193) & 0xFFFFFFFF
    return state


def max_consecutive(waves: list[int]) -> int:
    best = current = 0
    previous = None
    for wave in sorted(waves):
        current = current + 1 if previous is not None and wave == previous + 1 else 1
        best = max(best, current)
        previous = wave
    return best


def round_half_up(numerator: int, denominator: int) -> int:
    quotient, remainder = divmod(numerator, denominator)
    return quotient + int(remainder * 2 >= denominator)


def zone_and_score(h: int, t: int, f: int, d: int) -> tuple[str, int]:
    upgrade_limit = 0 if d == 0 else 1 if d == 5 else 2
    hold_limit = 0 if d == 0 else 2 if d == 5 else 3
    if h * 100 >= t * 80 and f <= upgrade_limit:
        zone = "UPGRADE"
    elif h * 100 >= t * 70 and f <= hold_limit:
        zone = "HOLD"
    else:
        zone = "FAIL"
    bonus = 10 if zone == "UPGRADE" else 0
    score = round_half_up(90 * h, t) + bonus if d == 0 else round_half_up(70 * h, t) + round_half_up(20 * (d - f), d) + bonus
    return zone, score


def validate_config(config: dict[str, Any]) -> dict[int, dict[str, Any]]:
    validate_game_config("CATCH_LIGHT", CONFIG_SCHEMA_ID, config)
    require(config.get("schemaVersion") == "1.5.0", "formal config branch is required")
    require(config["gameConfigSchemaId"] == CONFIG_SCHEMA_ID, "game config schema identity")
    require(config["generatorVersion"] == "catch-light-gen-1", "generator version mismatch")
    require(config["scoringRuleVersion"] == "1.5.0" and config["resultSchemaVersion"] == "A620-TRR-1.1", "scoring/result version mismatch")
    require(config["durationMs"] == 300000 and config["plannedBatchCount"] == 8, "session timing mismatch")
    require(config["designMaxLevel"] == 120 and config["qaSeed"] == 20260817 and config["configSetId"] == CONFIG_SET_ID, "config identity mismatch")
    require(config["sourceWorkbookName"] == SOURCE_WORKBOOK_NAME, "source workbook name")
    require(config["sourceWorkbookSha256"] == SOURCE_WORKBOOK_SHA256, "source workbook SHA-256")
    require(config["sourceWorkbookRole"] == "HISTORICAL_NUMERIC_INPUT_ONLY", "source workbook precedence role")
    require(config["sourceRequirementSha256"] == SOURCE_REQUIREMENT_SHA256, "v1.5 requirement SHA-256")
    require(config["publicRulesSha256"] == PUBLIC_RULES_SHA256, "public v1.3 SHA-256")

    fruit_catalog = config["fruitCatalog"]
    require({fruit["fruitId"] for fruit in fruit_catalog} == FRUITS, "fruit catalog must contain the exact 12 fruits")
    require(len({fruit["assetPath"] for fruit in fruit_catalog}) == 12, "fruit asset paths must be unique")
    fruit_by_id = {fruit["fruitId"]: fruit for fruit in fruit_catalog}
    pools = config["fruitPools"]
    require(set(pools["FP_CORE_A"]).isdisjoint(pools["FP_CORE_B"]), "CORE_A and CORE_B must be disjoint")
    require(set(pools["FP_CORE_A"]) | set(pools["FP_CORE_B"]) == FRUITS, "core pools must cover all fruits")
    require(set(pools["FP_TRANSFER"]) == FRUITS, "TRANSFER pool must contain all fruits")
    for pool_id in ("FP_CORE_A", "FP_CORE_B"):
        pool = pools[pool_id]
        for target in pool:
            target_tags = set(fruit_by_id[target]["similarityTags"])
            similar = [candidate for candidate in pool if candidate != target and target_tags & set(fruit_by_id[candidate]["similarityTags"])]
            clear = [candidate for candidate in pool if candidate != target and candidate not in similar]
            require(len(similar) >= 2 and len(clear) >= 2, f"{target}: pool must support both similar and clear distractors")

    grid_by_id = {grid["gridId"]: grid for grid in config["grids"]}
    require(set(grid_by_id) == {"2x2", "2x3", "3x3", "3x4"}, "grid catalog mismatch")
    for grid in grid_by_id.values():
        require(len(grid["slots"]) == grid["rows"] * grid["cols"], f"{grid['gridId']}: slot count mismatch")
        require(len({slot["slotId"] for slot in grid["slots"]}) == len(grid["slots"]), f"{grid['gridId']}: duplicate slot")
        require(all(slot["minHitWidthDp"] >= 56 and slot["minHitHeightDp"] >= 56 for slot in grid["slots"]), f"{grid['gridId']}: frozen 56dp hit-area minimum")

    wave_profiles = {profile["waveProfileId"]: profile for profile in config["waveProfiles"]}
    levels = config["levels"]
    require([level["level"] for level in levels] == EXPECTED_LEVELS, "W2 config must contain exactly L1/L28/L67/L102/L120 in sorted order")
    level_by_number = {level["level"]: level for level in levels}
    require(len(level_by_number) == len(levels), "duplicate level")
    require(len({level["contentVariantId"] for level in levels}) == len(levels), "duplicate content variant")
    require(len({level["seedKey"] for level in levels}) == len(levels), "duplicate seed key")

    for level in levels:
        profile = wave_profiles[level["waveProfileId"]]
        rotation = level["waveRotation"]
        targets = [profile["targetsByWave"][(index + rotation) % 8] for index in range(8)]
        distractors = [profile["distractorsByWave"][(index + rotation) % 8] for index in range(8)]
        require(sum(targets) == level["targetTotal"], f"L{level['level']}: target sum")
        require(sum(distractors) == level["distractorTotal"], f"L{level['level']}: distractor sum")
        require(all(t + d <= level["sameScreenCap"] for t, d in zip(targets, distractors)), f"L{level['level']}: same-screen cap")
        require(sum(d > 0 for d in distractors) == level["coexistWaveCount"], f"L{level['level']}: coexist wave count")
        require(sum(t + d == level["sameScreenCap"] for t, d in zip(targets, distractors)) == level["peakWaveCount"], f"L{level['level']}: peak wave count")
        require((level["stimulusLifecycleMs"], level["activeHoldMs"], level["interWaveBlankMs"], level["postLastBufferMs"]) == TIMING_BY_BAND[level["timingBand"]], f"L{level['level']}: timing-band tuple")
        require((level["waveCount"], level["roundActiveMs"], level["firstWaveMs"], level["waveSpacingMs"], level["enterAnimationMs"], level["exitAnimationMs"], level["hitFeedbackMs"]) == (8, 30000, 500, 3650, 200, 200, 300), f"L{level['level']}: fixed timing constants")
        require(level["enterAnimationMs"] + level["activeHoldMs"] + level["exitAnimationMs"] == level["stimulusLifecycleMs"], f"L{level['level']}: lifecycle sum")
        require(level["waveSpacingMs"] - level["stimulusLifecycleMs"] == level["interWaveBlankMs"], f"L{level['level']}: inter-wave blank")
        require(level["interWaveBlankMs"] >= level["hitFeedbackMs"], f"L{level['level']}: feedback must fit blank")
        require(level["firstWaveMs"] + 7 * level["waveSpacingMs"] + level["stimulusLifecycleMs"] + level["postLastBufferMs"] == 30000, f"L{level['level']}: operation closure")
        require(level["doubleTargetCount"] == 0 or (level["level"] >= 102 and level["doubleWindowMs"] >= 1200), f"L{level['level']}: double gate")
        require(level["similarDistractorCount"] <= level["distractorTotal"], f"L{level['level']}: similar distractor quota")
        require(level["targetFarEdgeCount"] <= level["targetTotal"], f"L{level['level']}: target far-edge quota")
        require(level["distractorFarEdgeCount"] <= level["distractorTotal"], f"L{level['level']}: distractor far-edge quota")
        require(level["doubleTargetCount"] <= min(level["targetTotal"], 8), f"L{level['level']}: double quota")
        require(level["minTargetHits"] == (level["targetTotal"] * 80 + 99) // 100, f"L{level['level']}: minimum 80-percent target hits")
        expected_false = {0: (0, 0, "SC_NO_DISTRACTOR"), 5: (1, 2, "SC_WITH_DISTRACTOR"), 10: (2, 3, "SC_WITH_DISTRACTOR")}[level["distractorTotal"]]
        require((level["upgradeFalseLimit"], level["holdFalseLimit"], level["scoringProfileId"]) == expected_false, f"L{level['level']}: false-touch threshold profile")
        require(level["backgroundId"] == f"BG{(level['level'] + 14) // 15:02d}", f"L{level['level']}: background chapter mapping")

    require(level_by_number[1]["targetTotal"] == 10 and level_by_number[1]["distractorTotal"] == 0, "L1 representative facts")
    require(level_by_number[28]["targetTotal"] == 15 and level_by_number[28]["distractorTotal"] == 5, "L28 representative facts")
    require(level_by_number[102]["doubleTargetCount"] == 2 and level_by_number[102]["doubleWindowMs"] == 1500, "L102 representative facts")
    require(level_by_number[120]["targetTotal"] == 25 and level_by_number[120]["distractorTotal"] == 10 and level_by_number[120]["sameScreenCap"] == 5 and level_by_number[120]["doubleTargetCount"] == 6, "L120 representative facts")
    return level_by_number


def validate_golden(golden: dict[str, Any], levels: dict[int, dict[str, Any]]) -> None:
    require(golden["goldenVersion"] == "A620-CATCH-LIGHT-GOLDEN-1", "golden version")
    require(golden["qaSeed"] == 20260817, "golden QA seed")
    require([vector["level"] for vector in golden["vectors"]] == EXPECTED_LEVELS, "golden level set")

    for vector in golden["vectors"]:
        projection = copy.deepcopy(vector)
        supplied_vector_hash = projection.pop("vectorSha256")
        require(canonical_sha256(projection) == supplied_vector_hash, f"L{vector['level']}: vector hash")
        schedule = vector["schedule"]
        schedule_projection = copy.deepcopy(schedule)
        supplied_schedule_hash = schedule_projection.pop("scheduleSha256")
        require(canonical_sha256(schedule_projection) == supplied_schedule_hash, f"L{vector['level']}: schedule hash")
        level = levels[vector["level"]]
        require(schedule["level"] == vector["level"] and schedule["sessionSeed"] == 20260817 and schedule["batchOrdinal"] == 1, "golden schedule identity")
        expected_batch_material = f"{level['seedKey']}|20260817|1|0"
        require(schedule["batchPlanSeedMaterial"] == expected_batch_material, f"L{vector['level']}: batch seed material")
        require(schedule["batchPlanSeed32"] == fnv1a32(expected_batch_material), f"L{vector['level']}: batch FNV")
        require(len(schedule["waves"]) == 8, f"L{vector['level']}: eight waves")
        instances = [instance for wave in schedule["waves"] for instance in wave["instances"]]
        targets = [instance for instance in instances if instance["role"] == "TARGET"]
        distractors = [instance for instance in instances if instance["role"] == "DISTRACTOR"]
        require(len(targets) == level["targetTotal"] and len(distractors) == level["distractorTotal"], f"L{vector['level']}: T/D totals")
        require(all(instance["fruitId"] == schedule["targetFruitId"] for instance in targets), f"L{vector['level']}: fixed target")
        require(all(instance["fruitId"] != schedule["targetFruitId"] for instance in distractors), f"L{vector['level']}: target excluded from distractors")
        require(sum(instance["similarityClass"] == "SIMILAR" for instance in distractors) == level["similarDistractorCount"], f"L{vector['level']}: similar quota")
        require(sum(instance["edgeEmphasis"] for instance in targets) == level["targetFarEdgeCount"], f"L{vector['level']}: target edge quota")
        require(sum(instance["edgeEmphasis"] for instance in distractors) == level["distractorFarEdgeCount"], f"L{vector['level']}: distractor edge quota")
        require(sum(instance["isDouble"] for instance in targets) == level["doubleTargetCount"], f"L{vector['level']}: double quota")
        double_waves: list[int] = []
        for wave in schedule["waves"]:
            material = f"{level['seedKey']}|20260817|1|{wave['waveOrdinal']}"
            require(wave["seedMaterial"] == material and wave["seed32"] == fnv1a32(material), f"L{vector['level']} W{wave['waveOrdinal']}: seed")
            require(len(wave["instances"]) <= level["sameScreenCap"], f"L{vector['level']} W{wave['waveOrdinal']}: cap")
            require(len({instance["slotId"] for instance in wave["instances"]}) == len(wave["instances"]), f"L{vector['level']} W{wave['waveOrdinal']}: slot collision")
            distractor_ids = [instance["fruitId"] for instance in wave["instances"] if instance["role"] == "DISTRACTOR"]
            require(len(distractor_ids) == len(set(distractor_ids)), f"L{vector['level']} W{wave['waveOrdinal']}: distractor duplicate")
            doubles = [instance for instance in wave["instances"] if instance["isDouble"]]
            require(len(doubles) <= 1, f"L{vector['level']} W{wave['waveOrdinal']}: more than one double")
            if doubles:
                double_waves.append(wave["waveOrdinal"])
        if level["doublePatternId"] == "SEP_NO_W1":
            require(1 not in double_waves and max_consecutive(double_waves) <= 1, "SEP_NO_W1")
        if level["doublePatternId"] == "MAX3_CONSEC":
            require(max_consecutive(double_waves) <= 3, "MAX3_CONSEC")


def validate_package_assets() -> None:
    content_root = ROOT / "packages/catch-light/content"
    bundle_index = load(content_root / "bundle/index.json")
    manifest = load(ROOT / "packages/catch-light/manifest.base.json")
    compiled_config = load(content_root / bundle_index["configPath"])
    background_index_path = content_root / bundle_index["backgroundIndexPath"]
    background_index = load(background_index_path)

    require(bundle_index["gameCode"] == "CATCH_LIGHT", "bundle game code")
    require(bundle_index["status"] == "W2_HEADLESS_VERTICAL_SLICES", "bundle status")
    require(bundle_index["gameConfigSchemaId"] == CONFIG_SCHEMA_ID, "bundle game config schema")
    require(bundle_index["generatorVersion"] == "catch-light-gen-1", "bundle generator")
    require(bundle_index["scoringRuleVersion"] == "1.5.0", "bundle scoring rule")
    require(bundle_index["resultSchemaVersion"] == "A620-TRR-1.1", "bundle result schema")
    require(bundle_index["configSetId"] == CONFIG_SET_ID, "bundle config set")
    require(bundle_index["compiledConfigCanonicalSha256"] == canonical_sha256(compiled_config), "bundle compiled config canonical SHA-256")
    require(bundle_index["sourceWorkbookName"] == SOURCE_WORKBOOK_NAME and bundle_index["sourceWorkbookSha256"] == SOURCE_WORKBOOK_SHA256, "bundle workbook provenance")
    require(bundle_index["sourceWorkbookRole"] == "HISTORICAL_NUMERIC_INPUT_ONLY", "bundle workbook precedence role")
    require(bundle_index["sourceRequirementSha256"] == SOURCE_REQUIREMENT_SHA256 and bundle_index["publicRulesSha256"] == PUBLIC_RULES_SHA256, "bundle source document hashes")
    require(bundle_index["runtimeConfigHashDeclaration"] == {
        "mode": "SESSION_SCOPED_ANDROID_PREPARE",
        "algorithm": "SHA-256",
        "canonicalization": "A620_CANONICAL_JSON",
        "projection": "PREPARE_PAYLOAD_EXCLUDING_RUNTIME_CONFIG_HASH",
        "staticValueApplicable": False,
    }, "bundle runtimeConfigHash declaration")
    require(bundle_index["implementedLevels"] == [1, 28, 102, 120], "bundle representative levels")
    require(bundle_index["goldenOnlyAdditionalLevel"] == [67], "bundle golden-only level")
    require(bundle_index["cocosSceneStatus"] == "NOT_INCLUDED_IN_W2", "Cocos scope statement")
    require(bundle_index["fruitSpriteStatus"] == "PLACEHOLDER_REFERENCES_ONLY", "fruit sprite scope statement")

    require(manifest["runtimeContractVersion"] == "A620-TRC-1.1", "manifest wire version")
    require(manifest["coreProtocolVersion"] == "1.5.0", "manifest core protocol")
    require(manifest["generatorVersion"] == "catch-light-gen-1", "manifest generator")

    backgrounds = background_index["backgrounds"]
    require(background_index["sessionLockRule"] == "HIGHEST_UNLOCKED_CHAPTER_SESSION_LOCK", "background session lock")
    require([item["backgroundId"] for item in backgrounds] == [f"BG{i:02d}" for i in range(1, 9)], "background ID set")
    require(len({item["path"] for item in backgrounds}) == 8, "background path uniqueness")
    for item in backgrounds:
        asset_path = content_root / item["path"]
        require(asset_path.is_file(), f"{item['backgroundId']}: missing asset")
        require(png_dimensions(asset_path) == (item["widthPx"], item["heightPx"]), f"{item['backgroundId']}: dimensions")
        require((item["widthPx"], item["heightPx"]) == (1600, 1000), f"{item['backgroundId']}: frozen dimensions")
        require(sha256_file(asset_path) == item["sha256"], f"{item['backgroundId']}: SHA-256")
        require(item["status"] == "SUPPLIED_REFERENCE_ASSET", f"{item['backgroundId']}: status")


def validate_evidence(evidence: dict[str, Any], levels: dict[int, dict[str, Any]]) -> None:
    expected_counts = {
        "L1-HOLD-8": 8,
        "L28-HOLD-8": 8,
        "L102-HOLD-8": 8,
        "L120-UPGRADE-8": 8,
        "L28-HOLD-0": 0,
        "L28-HOLD-1": 1,
        "L28-HOLD-7": 7,
    }
    scenarios = evidence["scenarios"]
    require({scenario["name"] for scenario in scenarios} == set(expected_counts), "headless scenario set")
    for scenario in scenarios:
        payload = scenario["payload"]
        quality = validate_game_payload(payload)
        expected = expected_counts[scenario["name"]]
        require(payload["eligibleBatchCount"] == expected, f"{scenario['name']}: eligible count")
        require(len(scenario["emittedBatchHashes"]) == expected, f"{scenario['name']}: BATCH_CLOSED emissions")
        require(scenario["emittedBatchHashes"] == [batch["batchPayloadSha256"] for batch in payload["eligibleBatches"]], f"{scenario['name']}: emitted evidence mismatch")
        require(payload["sessionRawScore"] == sum(batch["batchScore"] for batch in payload["eligibleBatches"]), f"{scenario['name']}: score sum")
        require(quality == ("COMPLETE_BATCH_SET" if expected == 8 else "NO_ELIGIBLE_BATCH" if expected == 0 else "PARTIAL_ELIGIBLE_BATCHES"), f"{scenario['name']}: quality flag derivation")

        game_metrics = payload["gameMetrics"]
        require(game_metrics["metricsVersion"] == "catch-light-session-metrics-1", f"{scenario['name']}: formal session metrics")
        require(game_metrics["passEngineType"] == "PE-EVENT", f"{scenario['name']}: pass engine")
        require(game_metrics["configSetId"] == "catch-light-v1.5-w2-vertical-slices", f"{scenario['name']}: config set")
        require(game_metrics["generatorVersion"] == "catch-light-gen-1", f"{scenario['name']}: generator")
        require(game_metrics["scoringRuleVersion"] == "1.5.0", f"{scenario['name']}: scoring rule")
        require(game_metrics["resultSchemaVersion"] == "A620-TRR-1.1", f"{scenario['name']}: result schema")
        require(game_metrics["pauseCount"] == 0 and game_metrics["totalPausedDurationMs"] == 0, f"{scenario['name']}: headless pause metrics")
        require(game_metrics["eligibleBatchCount"] == expected, f"{scenario['name']}: aggregate eligible count")
        require(game_metrics["incompleteBatchCount"] == len(payload["incompleteBatchAudit"]), f"{scenario['name']}: aggregate incomplete count")

        sum_h = sum(batch["gameBatchMetrics"]["H"] for batch in payload["eligibleBatches"])
        sum_t = sum(batch["gameBatchMetrics"]["T"] for batch in payload["eligibleBatches"])
        sum_f = sum(batch["gameBatchMetrics"]["F"] for batch in payload["eligibleBatches"])
        sum_d = sum(batch["gameBatchMetrics"]["D"] for batch in payload["eligibleBatches"])
        require((game_metrics["H"], game_metrics["T"], game_metrics["F"], game_metrics["D"]) == (sum_h, sum_t, sum_f, sum_d), f"{scenario['name']}: H/T/F/D aggregate")
        require(game_metrics["eligibleTargetHits"] == sum_h and game_metrics["eligibleTargetInstances"] == sum_t, f"{scenario['name']}: target aggregate aliases")
        require(game_metrics["eligibleDistractorFalseTouches"] == sum_f and game_metrics["eligibleDistractorInstances"] == sum_d, f"{scenario['name']}: distractor aggregate aliases")

        for batch in payload["eligibleBatches"]:
            metrics = batch["gameBatchMetrics"]
            level = levels[batch["levelBefore"]]
            require(metrics["metricsVersion"] == "catch-light-batch-metrics-1", f"{scenario['name']} B{batch['batchOrdinal']}: formal metrics")
            require(metrics["configSetId"] == "catch-light-v1.5-w2-vertical-slices" and metrics["generatorVersion"] == "catch-light-gen-1", f"{scenario['name']} B{batch['batchOrdinal']}: generator identity")
            require(metrics["difficultyStateId"] == level["difficultyStateId"], f"{scenario['name']} B{batch['batchOrdinal']}: difficulty state")
            require(metrics["timingProfile"] == level["timingBand"], f"{scenario['name']} B{batch['batchOrdinal']}: timing profile")
            require(metrics["contentVariantId"] == level["contentVariantId"], f"{scenario['name']} B{batch['batchOrdinal']}: content variant")
            require(metrics["waveProfileId"] == level["waveProfileId"], f"{scenario['name']} B{batch['batchOrdinal']}: wave profile")
            require(metrics["seedKey"] == level["seedKey"], f"{scenario['name']} B{batch['batchOrdinal']}: seed key")
            require(metrics["H"] <= metrics["T"] and metrics["F"] <= metrics["D"], f"{scenario['name']} B{batch['batchOrdinal']}: count bounds")
            expected_zone, expected_score = zone_and_score(metrics["H"], metrics["T"], metrics["F"], metrics["D"])
            require(batch["resultZone"] == expected_zone, f"{scenario['name']} B{batch['batchOrdinal']}: result zone")
            require(batch["batchScore"] == expected_score, f"{scenario['name']} B{batch['batchOrdinal']}: score")
            require(metrics["targetTimeouts"] == metrics["T"] - metrics["H"], f"{scenario['name']} B{batch['batchOrdinal']}: target timeout count")
            require(metrics["distractorAvoided"] == metrics["D"] - metrics["F"], f"{scenario['name']} B{batch['batchOrdinal']}: distractor avoided count")
            require(metrics["doubleCompleted"] <= metrics["doubleTargets"] and metrics["doubleCompleted"] <= metrics["H"], f"{scenario['name']} B{batch['batchOrdinal']}: double counts")
            require(metrics["backgroundId"] == game_metrics["backgroundId"], f"{scenario['name']} B{batch['batchOrdinal']}: session background lock")
        for audit in payload["incompleteBatchAudit"]:
            partial = audit["partialMetrics"]
            require(partial["metricsVersion"] == "catch-light-partial-metrics-1", f"{scenario['name']}: formal partial metrics")
            require(partial["H"] <= partial["presentedTargetCount"], f"{scenario['name']}: partial target count")
            require(partial["F"] <= partial["presentedDistractorCount"], f"{scenario['name']}: partial distractor count")
            require(partial["unresolvedTargetCount"] <= partial["presentedTargetCount"] - partial["H"], f"{scenario['name']}: unresolved only among presented targets")
        if expected < 8:
            require(len(payload["incompleteBatchAudit"]) == 1, f"{scenario['name']}: expected one incomplete audit")
        else:
            require(payload["incompleteBatchAudit"] == [], f"{scenario['name']}: complete set has no incomplete audit")
    l120 = next(s for s in scenarios if s["name"] == "L120-UPGRADE-8")["payload"]
    require(all(batch["resultZone"] == "UPGRADE" and batch["levelTransition"] == "HOLD_MAX" and batch["levelAfter"] == 120 for batch in l120["eligibleBatches"]), "L120 upper-bound evidence")


def main() -> int:
    config_path = ROOT / "games/catch-light/configs/vertical-slices/catch-light-v1.5-w2.json"
    package_config = ROOT / "packages/catch-light/content/config/catch-light-v1.5-w2.json"
    golden_path = ROOT / "games/catch-light/golden-vectors/A620_W2_CATCH_LIGHT_golden_vectors.json"
    package_golden = ROOT / "packages/catch-light/content/golden/A620_W2_CATCH_LIGHT_golden_vectors.json"
    evidence_path = ROOT / "build/catch-light/A620_W2_CATCH_LIGHT_headless_results.json"
    require(config_path.read_bytes() == package_config.read_bytes(), "package config copy differs")
    require(golden_path.read_bytes() == package_golden.read_bytes(), "package golden copy differs")
    levels = validate_config(load(config_path))
    validate_golden(load(golden_path), levels)
    validate_evidence(load(evidence_path), levels)
    validate_package_assets()
    print("CATCH_LIGHT_W2_SCHEMA_AND_SEMANTIC_VALIDATION_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
