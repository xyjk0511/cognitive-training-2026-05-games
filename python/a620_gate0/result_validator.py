from __future__ import annotations

from copy import deepcopy
from typing import Any

from .canonical import canonical_sha256
from .game_schema import validate_game_specific_payload
from .schema import validate_schema


class ResultValidationError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ResultValidationError(message)


def derive_quality_flag(eligible: int, planned: int) -> str:
    _require(planned >= 1, "plannedBatchCount must be >= 1")
    _require(0 <= eligible <= planned, "eligibleBatchCount must be within 0..planned")
    if eligible == planned:
        return "COMPLETE_BATCH_SET"
    if eligible == 0:
        return "NO_ELIGIBLE_BATCH"
    return "PARTIAL_ELIGIBLE_BATCHES"


def _validate_level_transition(batch: dict[str, Any], design_max_level: int) -> None:
    before = batch["levelBefore"]
    after = batch["levelAfter"]
    zone = batch["resultZone"]
    transition = batch["levelTransition"]

    _require(1 <= before <= design_max_level, "levelBefore outside design range")
    _require(1 <= after <= design_max_level, "levelAfter outside design range")

    if zone == "UPGRADE":
        _require(transition in {"UP", "HOLD_MAX"}, "UPGRADE must use UP or HOLD_MAX")
        if transition == "UP":
            _require(before < design_max_level and after == before + 1, "UP must advance exactly one level below max")
        else:
            _require(before == design_max_level and after == before, "HOLD_MAX is only legal at designMaxLevel")
        return

    if zone == "HOLD":
        _require(transition == "HOLD" and after == before, "HOLD must keep the same level")
        return

    _require(zone == "FAIL", "unknown resultZone")
    _require(transition in {"RETRY", "DOWN", "HOLD_MIN"}, "FAIL must use RETRY, DOWN or HOLD_MIN")
    if transition == "DOWN":
        _require(before > 1 and after == before - 1, "DOWN must decrement exactly one level")
    elif transition == "HOLD_MIN":
        _require(before == 1 and after == 1, "HOLD_MIN is only legal at level 1")
    else:
        _require(after == before, "RETRY must keep the same level")


def validate_game_payload(
    payload: dict[str, Any],
    *,
    evidence_ledger: dict[int, str] | None = None,
    expected_game_code: str | None = None,
    expected_runtime_config_hash: str | None = None,
    expected_planned_batch_count: int | None = None,
    expected_design_max_level: int | None = None,
    expected_session_start_level: int | None = None,
    expected_duration_ms: int | None = None,
) -> str:
    validate_schema(payload, "a620_training_game_payload.schema.json")
    validate_game_specific_payload(payload)

    if expected_game_code is not None:
        _require(payload["gameCode"] == expected_game_code, "gameCode differs from PREPARE")
    if expected_runtime_config_hash is not None:
        _require(payload["runtimeConfigHash"] == expected_runtime_config_hash, "runtimeConfigHash differs from PREPARE")
    if expected_planned_batch_count is not None:
        _require(payload["plannedBatchCount"] == expected_planned_batch_count, "plannedBatchCount differs from PREPARE")
    if expected_design_max_level is not None:
        _require(payload["designMaxLevel"] == expected_design_max_level, "designMaxLevel differs from PREPARE")
    if expected_session_start_level is not None:
        _require(payload["sessionStartLevel"] == expected_session_start_level, "sessionStartLevel differs from PREPARE")
    if expected_duration_ms is not None:
        _require(payload["actualTrainingMs"] == expected_duration_ms, "actualTrainingMs differs from PREPARE durationMs")

    eligible = payload["eligibleBatches"]
    incomplete = payload["incompleteBatchAudit"]
    planned = payload["plannedBatchCount"]
    design_max = payload["designMaxLevel"]

    _require(payload["eligibleBatchCount"] == len(eligible), "eligibleBatchCount does not match eligibleBatches length")
    _require(len(eligible) <= planned, "eligible batches exceed plannedBatchCount")

    ordinals = [batch["batchOrdinal"] for batch in eligible]
    _require(ordinals == list(range(1, len(eligible) + 1)), "eligible batch ordinals must be contiguous from 1")

    incomplete_ordinals = [audit["batchOrdinal"] for audit in incomplete]
    _require(len(incomplete) <= 1, "at most one current incomplete batch may exist")
    if incomplete:
        _require(incomplete_ordinals == [len(eligible) + 1], "incomplete batch must immediately follow eligible batches")
        _require(incomplete[0]["batchOrdinal"] <= planned, "incomplete batch ordinal outside planned range")
        _require(incomplete[0]["startedAtActiveMs"] <= incomplete[0]["cutoffAtActiveMs"], "incomplete batch time order is invalid")
    _require(len(eligible) + len(incomplete) <= planned, "batch evidence exceeds plannedBatchCount")

    total = sum(batch["batchScore"] for batch in eligible)
    _require(payload["sessionRawScore"] == total, "sessionRawScore does not equal eligible batch score sum")
    _require(payload["sessionRawScoreMax"] == planned * 100, "sessionRawScoreMax must equal plannedBatchCount * 100")

    start_level = payload["sessionStartLevel"]
    _require(1 <= start_level <= design_max, "sessionStartLevel outside design range")
    previous_level = start_level
    previous_closed_at = -1

    for expected_ordinal, batch in enumerate(eligible, start=1):
        _require(batch["batchOrdinal"] == expected_ordinal, "eligible batch ordinal mismatch")
        _require(batch["levelBefore"] == previous_level, f"batch {expected_ordinal} levelBefore does not chain from previous levelAfter")
        _require(batch["closedAtActiveMs"] > previous_closed_at, "eligible batch close times must be strictly increasing")
        _validate_level_transition(batch, design_max)
        _require(batch["closed"] is True and batch["decisionEligible"] is True, "eligible batch is not closed/eligible")

        projection = deepcopy(batch)
        supplied_hash = projection.pop("batchPayloadSha256")
        expected_hash = canonical_sha256(projection)
        _require(supplied_hash == expected_hash, f"batch {batch['batchOrdinal']} hash is not self-consistent")
        if evidence_ledger is not None:
            _require(batch["batchOrdinal"] in evidence_ledger, f"batch {batch['batchOrdinal']} missing BATCH_CLOSED evidence")
            _require(evidence_ledger[batch["batchOrdinal"]] == supplied_hash, f"batch {batch['batchOrdinal']} differs from BATCH_CLOSED evidence")

        previous_level = batch["levelAfter"]
        previous_closed_at = batch["closedAtActiveMs"]

    if evidence_ledger is not None:
        _require(set(evidence_ledger) == set(ordinals), "BATCH_CLOSED evidence set differs from final eligibleBatches")

    expected_end = previous_level
    _require(payload["sessionEndLevel"] == expected_end, "sessionEndLevel does not match last eligible levelAfter")
    _require(payload["nextStartLevel"] == expected_end, "nextStartLevel does not match last eligible levelAfter")

    presented_levels = [start_level] + [batch["levelBefore"] for batch in eligible]
    if incomplete:
        audit = incomplete[0]
        _require(audit["levelBefore"] == expected_end, "incomplete batch levelBefore does not match current level")
        _require(audit["startedAtActiveMs"] >= previous_closed_at, "incomplete batch starts before the last eligible batch closed")
        _require(1 <= audit["levelBefore"] <= design_max, "incomplete batch level outside design range")
        presented_levels.append(audit["levelBefore"])
    _require(payload["sessionHighestPresentedLevel"] == max(presented_levels), "sessionHighestPresentedLevel does not match presented evidence")

    passed = [batch["levelBefore"] for batch in eligible if batch["resultZone"] == "UPGRADE"]
    expected_passed = max(passed) if passed else None
    _require(payload["sessionHighestPassedLevel"] == expected_passed, "sessionHighestPassedLevel does not match UPGRADE evidence")

    return derive_quality_flag(len(eligible), planned)


def validate_formal_result(result: dict[str, Any]) -> None:
    validate_schema(result, "a620_formal_training_result.schema.json")
    quality = validate_game_payload(result["gamePayload"])
    _require(result["completionState"] == "COMPLETE", "formal result must be COMPLETE")
    _require(result["gameCode"] == result["gamePayload"]["gameCode"], "formal result gameCode mismatch")
    _require(result["derivedQualityFlag"] == quality, "derivedQualityFlag mismatch")
    _require(result["resultPayloadSha256"] == canonical_sha256(result["gamePayload"]), "resultPayloadSha256 mismatch")


def build_formal_result(
    *,
    identity: dict[str, Any],
    payload: dict[str, Any],
    result_id: str,
    saved_at_utc: str,
    saved_at_uptime_ms: int,
) -> dict[str, Any]:
    quality = validate_game_payload(payload)
    payload_hash = canonical_sha256(payload)
    result = {
        "recordVersion": "A620-TRR-1.1",
        "resultId": result_id,
        "systemId": identity["systemId"],
        "deviceId": identity["deviceId"],
        "taskId": identity["taskId"],
        "taskItemId": identity["taskItemId"],
        "executionAttempt": identity["executionAttempt"],
        "runtimeSessionId": identity["runtimeSessionId"],
        "monotonicEpochId": identity["monotonicEpochId"],
        "gameCode": payload["gameCode"],
        "packageVersion": identity["packageVersion"],
        "coreProtocolVersion": identity["coreProtocolVersion"],
        "contractVersion": "A620-TRC-1.1",
        "completionState": "COMPLETE",
        "derivedQualityFlag": quality,
        "resultPayloadSha256": payload_hash,
        "savedAtUtc": saved_at_utc,
        "savedAtUptimeMs": saved_at_uptime_ms,
        "gamePayload": payload,
    }
    validate_formal_result(result)
    return result


def build_execution_outcome(
    *,
    identity: dict[str, Any],
    game_code: str,
    completion_state: str,
    reason_code: str,
    active_elapsed_ms: int,
    recorded_at_utc: str,
    recorded_at_uptime_ms: int,
    audit_snapshot: dict[str, Any],
) -> dict[str, Any]:
    outcome = {
        "recordVersion": "A620-TEO-1.1",
        "systemId": identity["systemId"],
        "deviceId": identity["deviceId"],
        "taskId": identity["taskId"],
        "taskItemId": identity["taskItemId"],
        "executionAttempt": identity["executionAttempt"],
        "runtimeSessionId": identity["runtimeSessionId"],
        "monotonicEpochId": identity["monotonicEpochId"],
        "gameCode": game_code,
        "packageVersion": identity["packageVersion"],
        "coreProtocolVersion": identity["coreProtocolVersion"],
        "contractVersion": "A620-TRC-1.1",
        "completionState": completion_state,
        "reasonCode": reason_code,
        "activeElapsedMs": active_elapsed_ms,
        "recordedAtUtc": recorded_at_utc,
        "recordedAtUptimeMs": recorded_at_uptime_ms,
        "auditSnapshot": audit_snapshot,
    }
    validate_schema(outcome, "a620_training_execution_outcome.schema.json")
    return outcome
