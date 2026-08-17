from __future__ import annotations
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from .canonical import canonical_sha256
from .schema import validate_schema
from .game_schema import validate_game_specific_payload

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

def validate_game_payload(payload: dict[str, Any], *, evidence_ledger: dict[int, str] | None = None) -> str:
    validate_schema(payload, "a620_training_game_payload.schema.json")
    validate_game_specific_payload(payload)
    eligible = payload["eligibleBatches"]
    incomplete = payload["incompleteBatchAudit"]
    planned = payload["plannedBatchCount"]
    _require(payload["eligibleBatchCount"] == len(eligible), "eligibleBatchCount does not match eligibleBatches length")
    _require(len(eligible) <= planned, "eligible batches exceed plannedBatchCount")

    ordinals = [b["batchOrdinal"] for b in eligible]
    _require(ordinals == sorted(ordinals), "eligible batch ordinals must be increasing")
    _require(len(ordinals) == len(set(ordinals)), "eligible batch ordinals must be unique")
    _require(all(1 <= x <= planned for x in ordinals), "eligible batch ordinal outside planned range")

    incomplete_ordinals = [b["batchOrdinal"] for b in incomplete]
    _require(incomplete_ordinals == sorted(incomplete_ordinals), "incomplete batch ordinals must be increasing")
    _require(len(incomplete_ordinals) == len(set(incomplete_ordinals)), "incomplete batch ordinals must be unique")
    _require(all(1 <= x <= planned for x in incomplete_ordinals), "incomplete batch ordinal outside planned range")
    _require(set(ordinals).isdisjoint(incomplete_ordinals), "eligible and incomplete batch ordinals overlap")
    _require(ordinals == list(range(1, len(ordinals) + 1)), "eligible batch ordinals must start at 1 and be contiguous")
    _require(len(incomplete_ordinals) <= 1, "at most one incomplete batch audit is allowed at deadline")
    if incomplete_ordinals:
        _require(incomplete_ordinals[0] == len(ordinals) + 1, "incomplete batch must immediately follow eligible batches")

    total = sum(b["batchScore"] for b in eligible)
    _require(payload["sessionRawScore"] == total, "sessionRawScore does not equal eligible batch score sum")
    _require(payload["sessionRawScoreMax"] == planned * 100, "sessionRawScoreMax must equal plannedBatchCount * 100")

    start_level = payload["sessionStartLevel"]
    expected_end = eligible[-1]["levelAfter"] if eligible else start_level
    _require(payload["sessionEndLevel"] == expected_end, "sessionEndLevel does not match last eligible levelAfter")
    _require(payload["nextStartLevel"] == expected_end, "nextStartLevel does not match last eligible levelAfter")

    max_presented = max([start_level] + [b["levelBefore"] for b in eligible])
    _require(payload["sessionHighestPresentedLevel"] >= max_presented, "sessionHighestPresentedLevel is below presented evidence")
    passed = [b["levelBefore"] for b in eligible if b["resultZone"] == "UPGRADE"]
    expected_passed = max(passed) if passed else None
    _require(payload["sessionHighestPassedLevel"] == expected_passed, "sessionHighestPassedLevel does not match UPGRADE evidence")

    for batch in eligible:
        _require(batch["closed"] is True and batch["decisionEligible"] is True, "eligible batch is not closed/eligible")
        projection = deepcopy(batch)
        supplied_hash = projection.pop("batchPayloadSha256")
        expected_hash = canonical_sha256(projection)
        _require(supplied_hash == expected_hash, f"batch {batch['batchOrdinal']} hash is not self-consistent")
        if evidence_ledger is not None:
            _require(batch["batchOrdinal"] in evidence_ledger, f"batch {batch['batchOrdinal']} missing BATCH_CLOSED evidence")
            _require(evidence_ledger[batch["batchOrdinal"]] == supplied_hash, f"batch {batch['batchOrdinal']} differs from BATCH_CLOSED evidence")

    if evidence_ledger is not None:
        _require(set(evidence_ledger) == set(ordinals), "BATCH_CLOSED evidence set differs from final eligibleBatches")

    return derive_quality_flag(len(eligible), planned)

def build_formal_result(*, identity: dict[str, Any], payload: dict[str, Any], result_id: str, saved_at_utc: str, saved_at_uptime_ms: int, task_slot_state: str = "OCCUPIED") -> dict[str, Any]:
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
        "gameCode": payload["gameCode"],
        "packageVersion": identity["packageVersion"],
        "coreProtocolVersion": identity["coreProtocolVersion"],
        "contractVersion": "A620-TRC-1.1",
        "completionState": "COMPLETE",
        "syncState": "PENDING_UPLOAD",
        "taskSlotState": task_slot_state,
        "derivedQualityFlag": quality,
        "resultPayloadSha256": payload_hash,
        "savedAtUtc": saved_at_utc,
        "savedAtUptimeMs": saved_at_uptime_ms,
        "gamePayload": payload,
    }
    validate_schema(result, "a620_formal_training_result.schema.json")
    return result
