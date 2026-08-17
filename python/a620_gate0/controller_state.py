from __future__ import annotations

from typing import Any

from .schema import validate_schema


class ControllerStateError(ValueError):
    pass


ACTIVE_STATES = {
    "PREPARING",
    "READY",
    "START_SCHEDULED",
    "RUNNING",
    "PAUSE_SCHEDULED",
    "PAUSED",
    "RESUME_SCHEDULED",
    "FINALIZING",
    "RESULT_PENDING_COMMIT",
    "TERMINATING",
}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ControllerStateError(message)


def validate_controller_state_record(record: dict[str, Any]) -> None:
    validate_schema(record, "a620_controller_state_record.schema.json")
    runtime_state = record["runtimeState"]
    completion = record["completionState"]
    sync = record["syncState"]
    slot = record["taskSlotState"]
    result_id = record.get("resultId")

    if runtime_state == "UNPREPARED":
        _require(completion is None and sync is None and slot == "IDLE" and result_id is None, "UNPREPARED must be empty and IDLE")
        return

    if runtime_state in ACTIVE_STATES:
        _require(completion is None and sync is None and slot == "OCCUPIED" and result_id is None, "active runtime state must remain OCCUPIED without formal completion/sync")
        return

    if runtime_state == "RESULT_COMMITTED":
        _require(completion == "COMPLETE", "RESULT_COMMITTED requires COMPLETE")
        _require(sync in {"PENDING_UPLOAD", "WAITING_ACK", "SYNCED"}, "RESULT_COMMITTED requires a sync state")
        _require(slot in {"OCCUPIED", "END_RECONCILING", "IDLE"}, "RESULT_COMMITTED has invalid task slot state")
        _require(isinstance(result_id, str), "RESULT_COMMITTED requires resultId")
        return

    if runtime_state == "TERMINATED":
        _require(completion == "DISCARDED" and sync is None and result_id is None, "TERMINATED must be DISCARDED without result/sync")
        _require(slot in {"END_RECONCILING", "IDLE"}, "TERMINATED must reconcile or release the task slot")
        return

    if runtime_state == "ERROR":
        _require(completion == "INTERRUPTED" and sync is None and result_id is None, "ERROR must be INTERRUPTED without result/sync")
        _require(slot == "INTERRUPTED_WAIT", "ERROR must enter INTERRUPTED_WAIT")
        return

    raise ControllerStateError(f"unsupported runtimeState: {runtime_state}")


def build_controller_state_record(
    *,
    identity: dict[str, Any],
    runtime_state: str,
    completion_state: str | None,
    sync_state: str | None,
    task_slot_state: str,
    result_id: str | None,
    updated_at_utc: str,
    updated_at_uptime_ms: int,
) -> dict[str, Any]:
    record = {
        "recordVersion": "A620-CSR-1.1",
        "systemId": identity["systemId"],
        "deviceId": identity["deviceId"],
        "taskId": identity["taskId"],
        "taskItemId": identity["taskItemId"],
        "executionAttempt": identity["executionAttempt"],
        "runtimeSessionId": identity["runtimeSessionId"],
        "monotonicEpochId": identity["monotonicEpochId"],
        "packageVersion": identity["packageVersion"],
        "coreProtocolVersion": identity["coreProtocolVersion"],
        "contractVersion": "A620-TRC-1.1",
        "runtimeState": runtime_state,
        "completionState": completion_state,
        "syncState": sync_state,
        "taskSlotState": task_slot_state,
        "resultId": result_id,
        "updatedAtUtc": updated_at_utc,
        "updatedAtUptimeMs": updated_at_uptime_ms,
    }
    validate_controller_state_record(record)
    return record
