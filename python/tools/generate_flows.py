from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from a620_gate0.canonical import canonical_sha256

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "contracts/test-vectors"
BASE = {
    "contractVersion": "A620-TRC-1.1",
    "systemId": "SYS-001",
    "deviceId": "TAB-01",
    "taskId": "TASK-001",
    "taskItemId": "ITEM-01",
    "executionAttempt": 1,
    "runtimeSessionId": "RUN-001",
    "packageVersion": "1.5.0",
    "coreProtocolVersion": "1.5.0",
    "monotonicEpochId": "BOOT-A",
}
seq = {"ANDROID_CONTROLLER": 0, "COCOS_RUNTIME": 0}


def reset(*, package_version: str = "1.5.0", core_protocol_version: str = "1.5.0") -> None:
    seq["ANDROID_CONTROLLER"] = 0
    seq["COCOS_RUNTIME"] = 0
    BASE["packageVersion"] = package_version
    BASE["coreProtocolVersion"] = core_protocol_version


def message(
    message_type: str,
    role: str,
    message_id: str,
    uptime: int,
    payload: dict[str, Any],
    correlation_id: str | None = None,
    utc: str = "2026-08-17T05:00:00Z",
) -> dict[str, Any]:
    seq[role] += 1
    return {
        **BASE,
        "messageType": message_type,
        "messageId": message_id,
        "correlationId": correlation_id,
        "senderRole": role,
        "senderSeq": seq[role],
        "sentAtUtc": utc,
        "sentAtUptimeMs": uptime,
        "payload": payload,
    }


def prepare_payload(
    *,
    game_code: str,
    session_seed: int,
    start_level: int,
    design_max_level: int,
    planned_batch_count: int,
    scoring_version: str,
    generator_version: str,
    config_schema_id: str,
) -> dict[str, Any]:
    payload = {
        "clockProfile": "A620-UPTIME-MS-1",
        "durationMs": 300000,
        "sessionSeed": session_seed,
        "sessionStartLevel": start_level,
        "designMaxLevel": design_max_level,
        "plannedBatchCount": planned_batch_count,
        "scoringRuleVersion": scoring_version,
        "resultSchemaVersion": "A620-TRR-1.1",
        "generatorVersion": generator_version,
        "gameCode": game_code,
        "gameConfigSchemaId": config_schema_id,
        "gameConfig": {},
    }
    payload["runtimeConfigHash"] = canonical_sha256(payload)
    return payload


def batch(
    ordinal: int,
    level_before: int,
    zone: str,
    transition: str,
    level_after: int,
    score: int,
    closed_ms: int,
) -> dict[str, Any]:
    payload = {
        "batchOrdinal": ordinal,
        "closed": True,
        "decisionEligible": True,
        "levelBefore": level_before,
        "resultZone": zone,
        "levelTransition": transition,
        "levelAfter": level_after,
        "batchScore": score,
        "closedAtActiveMs": closed_ms,
        "gameBatchMetrics": {"H": 8, "T": 10, "F": 0, "D": 0},
    }
    payload["batchPayloadSha256"] = canonical_sha256(payload)
    return payload


def complete_flow() -> list[dict[str, Any]]:
    reset()
    flow: list[dict[str, Any]] = []
    prepare = prepare_payload(
        game_code="CATCH_LIGHT",
        session_seed=20260817,
        start_level=1,
        design_max_level=120,
        planned_batch_count=8,
        scoring_version="1.5.0",
        generator_version="catch-light-gen-1",
        config_schema_id="urn:a620:catch-light:config:1.5",
    )
    config_hash = prepare["runtimeConfigHash"]
    flow.append(message("PREPARE", "ANDROID_CONTROLLER", "cmd-1", 100, prepare))
    flow.append(message("READY", "COCOS_RUNTIME", "evt-1", 150, {"runtimeConfigHash": config_hash, "plannedBatchCount": 8, "runtimeState": "READY"}, "cmd-1"))
    flow.append(message("START", "ANDROID_CONTROLLER", "cmd-2", 500, {"effectiveStartUptimeMs": 1000, "cutoffUptimeMs": 301000, "activeElapsedMs": 0, "clockRevision": 1, "commandLeadTimeMs": 500}))
    flow.append(message("COMMAND_ACCEPTED", "COCOS_RUNTIME", "evt-2", 550, {"acceptedMessageType": "START", "effectiveAtUptimeMs": 1000, "runtimeState": "START_SCHEDULED", "clockRevision": 1}, "cmd-2"))
    flow.append(message("STARTED", "COCOS_RUNTIME", "evt-3", 1000, {"effectiveStartUptimeMs": 1000, "cutoffUptimeMs": 301000, "runtimeState": "RUNNING", "clockRevision": 1}, "cmd-2"))

    flow.append(message("QUERY_STATE", "ANDROID_CONTROLLER", "cmd-query", 1500, {}))
    flow.append(message("STATE_SNAPSHOT", "COCOS_RUNTIME", "evt-snapshot", 1510, {"runtimeState": "RUNNING", "activeElapsedMs": 510, "clockRevision": 1, "lastAppliedControllerSeq": 3}, "cmd-query"))
    flow.append(message("HEARTBEAT", "COCOS_RUNTIME", "evt-heartbeat", 2000, {"runtimeState": "RUNNING", "activeElapsedMs": 1000, "clockRevision": 1, "lastAppliedControllerSeq": 3}))

    batches: list[dict[str, Any]] = []
    for i in range(1, 8):
        item = batch(i, i, "UPGRADE", "UP", i + 1, 100, i * 37500)
        batches.append(deepcopy(item))
        flow.append(message("BATCH_CLOSED", "COCOS_RUNTIME", f"evt-b{i}", 1000 + i * 37500, deepcopy(item)))

    flow.append(message("DEADLINE", "ANDROID_CONTROLLER", "cmd-deadline", 301000, {"cutoffUptimeMs": 301000, "activeElapsedMs": 300000, "clockRevision": 1}))
    game_payload = {
        "gameCode": "CATCH_LIGHT",
        "gamePayloadVersion": "A620-GP-1.1",
        "runtimeConfigHash": config_hash,
        "designMaxLevel": 120,
        "plannedBatchCount": 8,
        "eligibleBatchCount": 7,
        "eligibleBatches": batches,
        "incompleteBatchAudit": [{"batchOrdinal": 8, "levelBefore": 8, "cutoffReason": "DEADLINE", "startedAtActiveMs": 262500, "cutoffAtActiveMs": 300000, "partialMetrics": {"waveOrdinal": 8}}],
        "sessionStartLevel": 1,
        "sessionEndLevel": 8,
        "sessionHighestPresentedLevel": 8,
        "sessionHighestPassedLevel": 7,
        "nextStartLevel": 8,
        "sessionRawScore": 700,
        "sessionRawScoreMax": 800,
        "actualTrainingMs": 300000,
        "gameMetrics": {"totalTouches": 70},
    }
    payload_hash = canonical_sha256(game_payload)
    flow.append(message("RESULT_READY", "COCOS_RUNTIME", "evt-result", 301010, {"resultDraftSha256": payload_hash, "gamePayload": game_payload}))
    flow.append(message("ACK_RESULT_COMMITTED", "ANDROID_CONTROLLER", "cmd-ack", 301020, {"resultId": "RES-001", "resultPayloadSha256": payload_hash, "committedAtUtc": "2026-08-17T05:00:00Z", "committedAtUptimeMs": 301015}, "evt-result"))
    return flow


def pause_flow() -> list[dict[str, Any]]:
    reset(package_version="1.2.1", core_protocol_version="1.2.1")
    flow: list[dict[str, Any]] = []
    prepare = prepare_payload(
        game_code="SIGNAL_STATION",
        session_seed=1,
        start_level=1,
        design_max_level=96,
        planned_batch_count=8,
        scoring_version="1.2.1",
        generator_version="signal-gen-1",
        config_schema_id="urn:a620:signal-station:config:1.2.1",
    )
    config_hash = prepare["runtimeConfigHash"]
    flow.append(message("PREPARE", "ANDROID_CONTROLLER", "p-cmd-1", 100, prepare))
    flow.append(message("READY", "COCOS_RUNTIME", "p-evt-1", 150, {"runtimeConfigHash": config_hash, "plannedBatchCount": 8, "runtimeState": "READY"}, "p-cmd-1"))
    flow.append(message("START", "ANDROID_CONTROLLER", "p-cmd-2", 500, {"effectiveStartUptimeMs": 1000, "cutoffUptimeMs": 301000, "activeElapsedMs": 0, "clockRevision": 1, "commandLeadTimeMs": 500}))
    flow.append(message("COMMAND_ACCEPTED", "COCOS_RUNTIME", "p-evt-2", 550, {"acceptedMessageType": "START", "effectiveAtUptimeMs": 1000, "runtimeState": "START_SCHEDULED", "clockRevision": 1}, "p-cmd-2"))
    flow.append(message("STARTED", "COCOS_RUNTIME", "p-evt-3", 1000, {"effectiveStartUptimeMs": 1000, "cutoffUptimeMs": 301000, "runtimeState": "RUNNING", "clockRevision": 1}, "p-cmd-2"))
    flow.append(message("PAUSE", "ANDROID_CONTROLLER", "p-cmd-3", 60000, {"effectivePauseUptimeMs": 60300, "activeElapsedMs": 59300, "clockRevision": 2, "pauseLeadTimeMs": 300, "reasonCode": "THERAPIST_PAUSE"}))
    flow.append(message("COMMAND_ACCEPTED", "COCOS_RUNTIME", "p-evt-4", 60050, {"acceptedMessageType": "PAUSE", "effectiveAtUptimeMs": 60300, "runtimeState": "PAUSE_SCHEDULED", "clockRevision": 2}, "p-cmd-3"))
    flow.append(message("PAUSED", "COCOS_RUNTIME", "p-evt-5", 60300, {"effectivePauseUptimeMs": 60300, "activeElapsedMs": 59300, "runtimeState": "PAUSED", "clockRevision": 2}, "p-cmd-3"))
    flow.append(message("HEARTBEAT", "COCOS_RUNTIME", "p-evt-h1", 62000, {"runtimeState": "PAUSED", "activeElapsedMs": 59300, "clockRevision": 2, "lastAppliedControllerSeq": 3}))
    flow.append(message("RESUME", "ANDROID_CONTROLLER", "p-cmd-4", 65000, {"countdownMs": 3000, "resumeInputEnabledUptimeMs": 68000, "cutoffUptimeMs": 308700, "activeElapsedMs": 59300, "clockRevision": 3}))
    flow.append(message("COMMAND_ACCEPTED", "COCOS_RUNTIME", "p-evt-6", 65050, {"acceptedMessageType": "RESUME", "effectiveAtUptimeMs": 68000, "runtimeState": "RESUME_SCHEDULED", "clockRevision": 3}, "p-cmd-4"))
    flow.append(message("RESUMED", "COCOS_RUNTIME", "p-evt-7", 68000, {"resumeInputEnabledUptimeMs": 68000, "cutoffUptimeMs": 308700, "activeElapsedMs": 59300, "runtimeState": "RUNNING", "clockRevision": 3}, "p-cmd-4"))
    flow.append(message("HEARTBEAT", "COCOS_RUNTIME", "p-evt-h2", 69000, {"runtimeState": "RUNNING", "activeElapsedMs": 60300, "clockRevision": 3, "lastAppliedControllerSeq": 4}))
    flow.append(message("DEADLINE", "ANDROID_CONTROLLER", "p-cmd-d", 308700, {"cutoffUptimeMs": 308700, "activeElapsedMs": 300000, "clockRevision": 3}))
    game_payload = {
        "gameCode": "SIGNAL_STATION",
        "gamePayloadVersion": "A620-GP-1.1",
        "runtimeConfigHash": config_hash,
        "designMaxLevel": 96,
        "plannedBatchCount": 8,
        "eligibleBatchCount": 0,
        "eligibleBatches": [],
        "incompleteBatchAudit": [{"batchOrdinal": 1, "levelBefore": 1, "cutoffReason": "DEADLINE", "startedAtActiveMs": 0, "cutoffAtActiveMs": 300000, "partialMetrics": {}}],
        "sessionStartLevel": 1,
        "sessionEndLevel": 1,
        "sessionHighestPresentedLevel": 1,
        "sessionHighestPassedLevel": None,
        "nextStartLevel": 1,
        "sessionRawScore": 0,
        "sessionRawScoreMax": 800,
        "actualTrainingMs": 300000,
        "gameMetrics": {},
    }
    payload_hash = canonical_sha256(game_payload)
    flow.append(message("RESULT_READY", "COCOS_RUNTIME", "p-evt-r", 308710, {"resultDraftSha256": payload_hash, "gamePayload": game_payload}))
    flow.append(message("ACK_RESULT_COMMITTED", "ANDROID_CONTROLLER", "p-cmd-a", 308720, {"resultId": "RES-P", "resultPayloadSha256": payload_hash, "committedAtUtc": "2026-08-17T05:00:00Z", "committedAtUptimeMs": 308715}, "p-evt-r"))
    return flow


def terminated_flow() -> list[dict[str, Any]]:
    reset()
    flow: list[dict[str, Any]] = []
    prepare = prepare_payload(
        game_code="CATCH_LIGHT",
        session_seed=1,
        start_level=1,
        design_max_level=120,
        planned_batch_count=8,
        scoring_version="1.5.0",
        generator_version="catch-light-gen-1",
        config_schema_id="urn:a620:catch-light:config:1.5",
    )
    config_hash = prepare["runtimeConfigHash"]
    flow.append(message("PREPARE", "ANDROID_CONTROLLER", "t-c1", 100, prepare))
    flow.append(message("READY", "COCOS_RUNTIME", "t-e1", 150, {"runtimeConfigHash": config_hash, "plannedBatchCount": 8, "runtimeState": "READY"}, "t-c1"))
    flow.append(message("START", "ANDROID_CONTROLLER", "t-c2", 500, {"effectiveStartUptimeMs": 1000, "cutoffUptimeMs": 301000, "activeElapsedMs": 0, "clockRevision": 1, "commandLeadTimeMs": 500}))
    flow.append(message("COMMAND_ACCEPTED", "COCOS_RUNTIME", "t-e2", 550, {"acceptedMessageType": "START", "effectiveAtUptimeMs": 1000, "runtimeState": "START_SCHEDULED", "clockRevision": 1}, "t-c2"))
    flow.append(message("STARTED", "COCOS_RUNTIME", "t-e3", 1000, {"effectiveStartUptimeMs": 1000, "cutoffUptimeMs": 301000, "runtimeState": "RUNNING", "clockRevision": 1}, "t-c2"))
    flow.append(message("TERMINATE", "ANDROID_CONTROLLER", "t-c3", 2000, {"effectiveTerminateUptimeMs": 2200, "clockRevision": 2, "reasonCode": "MANAGER_TERMINATE"}))
    flow.append(message("COMMAND_ACCEPTED", "COCOS_RUNTIME", "t-e4", 2050, {"acceptedMessageType": "TERMINATE", "effectiveAtUptimeMs": 2200, "runtimeState": "TERMINATING", "clockRevision": 2}, "t-c3"))
    flow.append(message("TERMINATED", "COCOS_RUNTIME", "t-e5", 2200, {"effectiveTerminateUptimeMs": 2200, "runtimeState": "TERMINATED", "reasonCode": "MANAGER_TERMINATE"}, "t-c3"))
    return flow


def same_time_terminate_flow() -> list[dict[str, Any]]:
    flow = terminated_flow()[:5]
    # Continue the same sequences after STARTED.
    flow.append(message("TERMINATE", "ANDROID_CONTROLLER", "st-c3", 300900, {"effectiveTerminateUptimeMs": 301000, "clockRevision": 2, "reasonCode": "MANAGER_TERMINATE"}))
    flow.append(message("COMMAND_ACCEPTED", "COCOS_RUNTIME", "st-e4", 300950, {"acceptedMessageType": "TERMINATE", "effectiveAtUptimeMs": 301000, "runtimeState": "TERMINATING", "clockRevision": 2}, "st-c3"))
    flow.append(message("TERMINATED", "COCOS_RUNTIME", "st-e5", 301000, {"effectiveTerminateUptimeMs": 301000, "runtimeState": "TERMINATED", "reasonCode": "MANAGER_TERMINATE"}, "st-c3"))
    return flow


def error_flow() -> list[dict[str, Any]]:
    flow = terminated_flow()[:5]
    flow.append(message("RUNTIME_ERROR", "COCOS_RUNTIME", "x-e4", 2000, {"errorCode": "A620-RUNTIME-CRASH", "fatal": True, "runtimeState": "RUNNING", "details": {}}))
    return flow


def write_vector(name: str, messages: list[dict[str, Any]], expected: str) -> None:
    (OUT / f"{name}.json").write_text(
        json.dumps({"expectedOutcome": expected, "messages": messages}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


valid = {
    "valid_complete_flow": (complete_flow(), "COMPLETE"),
    "valid_pause_complete_flow": (pause_flow(), "COMPLETE"),
    "valid_terminated_flow": (terminated_flow(), "TERMINATED"),
    "valid_same_time_terminate_flow": (same_time_terminate_flow(), "TERMINATED"),
    "valid_error_flow": (error_flow(), "ERROR"),
}
for name, (messages, expected) in valid.items():
    write_vector(name, messages, expected)

base = complete_flow()
mutations: dict[str, list[dict[str, Any]]] = {}

mutations["invalid_missing_start_accepted"] = [m for m in deepcopy(base) if m["messageId"] != "evt-2"]

mutations["invalid_ready_hash"] = deepcopy(base)
next(m for m in mutations["invalid_ready_hash"] if m["messageType"] == "READY")["payload"]["runtimeConfigHash"] = "f" * 64

mutations["invalid_started_cutoff"] = deepcopy(base)
next(m for m in mutations["invalid_started_cutoff"] if m["messageType"] == "STARTED")["payload"]["cutoffUptimeMs"] += 1

mutations["invalid_result_from_running"] = deepcopy(base)
mutations["invalid_result_from_running"] = [m for m in mutations["invalid_result_from_running"] if m["messageType"] != "DEADLINE"]
result_message = next(m for m in mutations["invalid_result_from_running"] if m["messageType"] == "RESULT_READY")
result_message["sentAtUptimeMs"] = 300999

mutations["invalid_batch_evidence_replaced"] = deepcopy(base)
result_message = next(m for m in mutations["invalid_batch_evidence_replaced"] if m["messageType"] == "RESULT_READY")
result_batch = result_message["payload"]["gamePayload"]["eligibleBatches"][0]
result_batch["batchScore"] = 99
projection = deepcopy(result_batch)
projection.pop("batchPayloadSha256")
result_batch["batchPayloadSha256"] = canonical_sha256(projection)
result_message["payload"]["gamePayload"]["sessionRawScore"] = 699
result_message["payload"]["resultDraftSha256"] = canonical_sha256(result_message["payload"]["gamePayload"])
next(m for m in mutations["invalid_batch_evidence_replaced"] if m["messageType"] == "ACK_RESULT_COMMITTED")["payload"]["resultPayloadSha256"] = result_message["payload"]["resultDraftSha256"]

mutations["invalid_ack_hash"] = deepcopy(base)
next(m for m in mutations["invalid_ack_hash"] if m["messageType"] == "ACK_RESULT_COMMITTED")["payload"]["resultPayloadSha256"] = "0" * 64

mutations["invalid_sender_time_backwards"] = deepcopy(base)
heart = next(m for m in mutations["invalid_sender_time_backwards"] if m["messageType"] == "HEARTBEAT")
heart["sentAtUptimeMs"] = 100

mutations["invalid_heartbeat_state"] = deepcopy(base)
next(m for m in mutations["invalid_heartbeat_state"] if m["messageType"] == "HEARTBEAT")["payload"]["runtimeState"] = "RESULT_COMMITTED"

mutations["invalid_query_without_snapshot"] = [m for m in deepcopy(base) if m["messageType"] != "STATE_SNAPSHOT"]

mutations["invalid_runtime_config_hash"] = deepcopy(base)
prepare_message = next(m for m in mutations["invalid_runtime_config_hash"] if m["messageType"] == "PREPARE")
prepare_message["payload"]["runtimeConfigHash"] = "0" * 64

mutations["invalid_pause_active_elapsed"] = deepcopy(pause_flow())
pause_message = next(m for m in mutations["invalid_pause_active_elapsed"] if m["messageType"] == "PAUSE")
pause_message["payload"]["activeElapsedMs"] = 100

mutations["invalid_pause_at_deadline"] = deepcopy(pause_flow())
start_message = next(m for m in mutations["invalid_pause_at_deadline"] if m["messageType"] == "START")
pause_message = next(m for m in mutations["invalid_pause_at_deadline"] if m["messageType"] == "PAUSE")
cutoff = start_message["payload"]["cutoffUptimeMs"]
pause_message["sentAtUptimeMs"] = cutoff - 300
pause_message["payload"]["effectivePauseUptimeMs"] = cutoff
pause_message["payload"]["pauseLeadTimeMs"] = 300
pause_message["payload"]["activeElapsedMs"] = 300000

mutations["invalid_prepare_start_above_max"] = deepcopy(base)
prepare_message = next(m for m in mutations["invalid_prepare_start_above_max"] if m["messageType"] == "PREPARE")
prepare_message["payload"]["sessionStartLevel"] = 121
prepare_message["payload"]["designMaxLevel"] = 120
projection = deepcopy(prepare_message["payload"]); projection.pop("runtimeConfigHash")
prepare_message["payload"]["runtimeConfigHash"] = canonical_sha256(projection)

mutations["invalid_prepare_batches_over_limit"] = deepcopy(base)
prepare_message = next(m for m in mutations["invalid_prepare_batches_over_limit"] if m["messageType"] == "PREPARE")
prepare_message["payload"]["plannedBatchCount"] = 1025
projection = deepcopy(prepare_message["payload"]); projection.pop("runtimeConfigHash")
prepare_message["payload"]["runtimeConfigHash"] = canonical_sha256(projection)

mutations["invalid_level_chain"] = deepcopy(base)
closed = next(m for m in mutations["invalid_level_chain"] if m["messageType"] == "BATCH_CLOSED" and m["payload"]["batchOrdinal"] == 2)
closed["payload"]["levelBefore"] = 99
closed["payload"]["levelAfter"] = 100
projection = deepcopy(closed["payload"])
projection.pop("batchPayloadSha256")
closed["payload"]["batchPayloadSha256"] = canonical_sha256(projection)
result_message = next(m for m in mutations["invalid_level_chain"] if m["messageType"] == "RESULT_READY")
result_batch = next(b for b in result_message["payload"]["gamePayload"]["eligibleBatches"] if b["batchOrdinal"] == 2)
result_batch.update(deepcopy(closed["payload"]))
result_message["payload"]["gamePayload"]["sessionHighestPresentedLevel"] = 100
result_message["payload"]["gamePayload"]["sessionHighestPassedLevel"] = 99
result_message["payload"]["resultDraftSha256"] = canonical_sha256(result_message["payload"]["gamePayload"])
next(m for m in mutations["invalid_level_chain"] if m["messageType"] == "ACK_RESULT_COMMITTED")["payload"]["resultPayloadSha256"] = result_message["payload"]["resultDraftSha256"]

mutations["invalid_highest_presented_inflated"] = deepcopy(base)
result_message = next(m for m in mutations["invalid_highest_presented_inflated"] if m["messageType"] == "RESULT_READY")
result_message["payload"]["gamePayload"]["sessionHighestPresentedLevel"] = 120
result_message["payload"]["resultDraftSha256"] = canonical_sha256(result_message["payload"]["gamePayload"])
next(m for m in mutations["invalid_highest_presented_inflated"] if m["messageType"] == "ACK_RESULT_COMMITTED")["payload"]["resultPayloadSha256"] = result_message["payload"]["resultDraftSha256"]

mutations["invalid_heartbeat_active_elapsed"] = deepcopy(base)
next(m for m in mutations["invalid_heartbeat_active_elapsed"] if m["messageType"] == "HEARTBEAT")["payload"]["activeElapsedMs"] = 999

for name, messages in mutations.items():
    write_vector(name, messages, "REJECT")
