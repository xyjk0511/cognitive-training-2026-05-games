from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .canonical import canonical_bytes
from .generated_profiles import WATCHDOG_SNAPSHOT_VERSION, WATCHDOG_TIMEOUTS_MS
from .schema import validate_schema

PREPARE_READY_TIMEOUT_MS = WATCHDOG_TIMEOUTS_MS["prepareReady"]
COMMAND_ACCEPTED_TIMEOUT_MS = WATCHDOG_TIMEOUTS_MS["commandAccepted"]
CONFIRMATION_GRACE_MS_BY_COMMAND = {
    "START": WATCHDOG_TIMEOUTS_MS["startConfirmationAfterBoundary"],
    "PAUSE": WATCHDOG_TIMEOUTS_MS["pauseConfirmationAfterBoundary"],
    "RESUME": WATCHDOG_TIMEOUTS_MS["resumeConfirmationAfterBoundary"],
    "TERMINATE": WATCHDOG_TIMEOUTS_MS["terminateConfirmationAfterBoundary"],
}
QUERY_STATE_TIMEOUT_MS = WATCHDOG_TIMEOUTS_MS["queryState"]
HEARTBEAT_SILENCE_MS = WATCHDOG_TIMEOUTS_MS["heartbeatSilence"]
FINALIZATION_RESULT_READY_TIMEOUT_MS = WATCHDOG_TIMEOUTS_MS["finalizationResultReady"]
LOCAL_RESULT_COMMIT_TIMEOUT_MS = WATCHDOG_TIMEOUTS_MS["localResultCommit"]


@dataclass(frozen=True)
class WatchdogFailure:
    code: str
    detected_at_uptime_ms: int
    runtime_state: str
    related_message_id: str | None
    action: str = "INTERRUPT_EXECUTION_WITHOUT_FORMAL_RESULT"


@dataclass(frozen=True)
class _Deadline:
    key: str
    code: str
    at_ms: int
    related_message_id: str | None


class RuntimeWatchdog:
    """Controller-side liveness and phase deadline reducer.

    This is independent from the business state reducer: it detects that a
    required process response or heartbeat failed to arrive, but never creates
    a formal result. The caller must persist an INTERRUPTED ExecutionOutcome
    and cancel the runtime outbox after a returned failure.
    """

    SNAPSHOT_VERSION = WATCHDOG_SNAPSHOT_VERSION
    STATE_SET = {
        "UNPREPARED", "PREPARING", "READY", "START_SCHEDULED", "RUNNING",
        "PAUSE_SCHEDULED", "PAUSED", "RESUME_SCHEDULED", "FINALIZING",
        "RESULT_PENDING_COMMIT", "RESULT_COMMITTED", "TERMINATING", "TERMINATED", "ERROR",
    }

    def __init__(self) -> None:
        self.runtime_state = "UNPREPARED"
        self._deadlines: dict[str, _Deadline] = {}
        self._failure: WatchdogFailure | None = None

    def _arm(self, key: str, code: str, at_ms: int, related: str | None) -> None:
        if at_ms < 0:
            raise ValueError("watchdog deadline must be non-negative")
        self._deadlines[key] = _Deadline(key, code, at_ms, related)

    def _clear(self, key: str) -> None:
        self._deadlines.pop(key, None)

    def _terminal_failure(self, code: str, now_ms: int, related: str | None) -> WatchdogFailure:
        if self._failure is None:
            self._failure = WatchdogFailure(code, now_ms, self.runtime_state, related)
            self._deadlines.clear()
            self.runtime_state = "ERROR"
        return self._failure

    def observe_outbound(self, message: dict[str, Any]) -> None:
        if self._failure is not None:
            return
        validate_schema(message, "a620_training_runtime_message.schema.json")
        if message["senderRole"] != "ANDROID_CONTROLLER":
            raise ValueError("observe_outbound accepts Android controller messages only")
        kind = message["messageType"]
        now = message["sentAtUptimeMs"]
        message_id = message["messageId"]
        payload = message["payload"]

        if kind == "PREPARE":
            self.runtime_state = "PREPARING"
            self._arm(f"READY:{message_id}", "READY_TIMEOUT", now + PREPARE_READY_TIMEOUT_MS, message_id)
        elif kind in {"START", "PAUSE", "RESUME", "TERMINATE"}:
            self._arm(
                f"ACCEPT:{message_id}",
                "COMMAND_ACCEPTED_TIMEOUT",
                now + COMMAND_ACCEPTED_TIMEOUT_MS,
                message_id,
            )
            field = {
                "START": "effectiveStartUptimeMs",
                "PAUSE": "effectivePauseUptimeMs",
                "RESUME": "resumeInputEnabledUptimeMs",
                "TERMINATE": "effectiveTerminateUptimeMs",
            }[kind]
            confirm = {"START": "STARTED", "PAUSE": "PAUSED", "RESUME": "RESUMED", "TERMINATE": "TERMINATED"}[kind]
            self._arm(
                f"{confirm}:{message_id}",
                f"{confirm}_TIMEOUT",
                payload[field] + CONFIRMATION_GRACE_MS_BY_COMMAND[kind],
                message_id,
            )
        elif kind == "QUERY_STATE":
            self._arm(f"STATE_SNAPSHOT:{message_id}", "STATE_SNAPSHOT_TIMEOUT", now + QUERY_STATE_TIMEOUT_MS, message_id)
        elif kind == "ACK_RESULT_COMMITTED":
            correlation = message["correlationId"]
            if correlation is not None:
                self._clear(f"LOCAL_COMMIT:{correlation}")
            self.runtime_state = "RESULT_COMMITTED"
            self._deadlines.clear()

    def observe_inbound(self, message: dict[str, Any]) -> WatchdogFailure | None:
        if self._failure is not None:
            return self._failure
        validate_schema(message, "a620_training_runtime_message.schema.json")
        if message["senderRole"] != "COCOS_RUNTIME":
            raise ValueError("observe_inbound accepts Cocos runtime messages only")
        kind = message["messageType"]
        now = message["sentAtUptimeMs"]
        correlation = message["correlationId"]

        if kind == "RUNTIME_ERROR":
            return self._terminal_failure("RUNTIME_ERROR", now, message["messageId"])
        if kind == "HEARTBEAT":
            self._arm("HEARTBEAT", "HEARTBEAT_TIMEOUT", now + HEARTBEAT_SILENCE_MS, message["messageId"])
            return None
        if kind == "READY" and correlation is not None:
            self._clear(f"READY:{correlation}")
            self.runtime_state = "READY"
        elif kind == "COMMAND_ACCEPTED" and correlation is not None:
            self._clear(f"ACCEPT:{correlation}")
        elif kind in {"STARTED", "PAUSED", "RESUMED", "TERMINATED"} and correlation is not None:
            self._clear(f"{kind}:{correlation}")
            self.runtime_state = message["payload"]["runtimeState"]
            if kind in {"STARTED", "PAUSED", "RESUMED"}:
                self._arm("HEARTBEAT", "HEARTBEAT_TIMEOUT", now + HEARTBEAT_SILENCE_MS, message["messageId"])
            if kind == "TERMINATED":
                self._deadlines.clear()
        elif kind == "STATE_SNAPSHOT" and correlation is not None:
            self._clear(f"STATE_SNAPSHOT:{correlation}")
        elif kind == "RESULT_READY":
            self._clear("RESULT_READY")
            self.runtime_state = "RESULT_PENDING_COMMIT"
            self._arm(
                f"LOCAL_COMMIT:{message['messageId']}",
                "LOCAL_RESULT_COMMIT_TIMEOUT",
                now + LOCAL_RESULT_COMMIT_TIMEOUT_MS,
                message["messageId"],
            )
        return None

    def enter_state(self, state: str, now_uptime_ms: int) -> None:
        if state not in self.STATE_SET or now_uptime_ms < 0:
            raise ValueError("invalid watchdog state transition input")
        if self._failure is not None:
            return
        self.runtime_state = state
        if state == "FINALIZING":
            self._arm("RESULT_READY", "RESULT_READY_TIMEOUT", now_uptime_ms + FINALIZATION_RESULT_READY_TIMEOUT_MS, None)
        elif state in {"RESULT_COMMITTED", "TERMINATED", "ERROR"}:
            self._deadlines.clear()

    def poll(self, now_uptime_ms: int) -> WatchdogFailure | None:
        if now_uptime_ms < 0:
            raise ValueError("watchdog poll time must be non-negative")
        if self._failure is not None:
            return self._failure
        expired = sorted(
            (deadline for deadline in self._deadlines.values() if deadline.at_ms <= now_uptime_ms),
            key=lambda item: (item.at_ms, item.code, item.key),
        )
        if not expired:
            return None
        first = expired[0]
        return self._terminal_failure(first.code, now_uptime_ms, first.related_message_id)

    def pending_deadlines(self) -> list[dict[str, Any]]:
        return [
            {
                "key": item.key,
                "code": item.code,
                "atUptimeMs": item.at_ms,
                "relatedMessageId": item.related_message_id,
            }
            for item in sorted(self._deadlines.values(), key=lambda value: (value.at_ms, value.key))
        ]
    def snapshot(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "snapshotVersion": self.SNAPSHOT_VERSION,
            "runtimeState": self.runtime_state,
            "deadlines": self.pending_deadlines(),
            "failure": None,
        }
        if self._failure is not None:
            value["failure"] = {
                "code": self._failure.code,
                "detectedAtUptimeMs": self._failure.detected_at_uptime_ms,
                "runtimeStateAtFailure": self._failure.runtime_state,
                "relatedMessageId": self._failure.related_message_id,
                "action": self._failure.action,
            }
        # Also applies the common resource budget before a host persists it.
        canonical_bytes(value)
        return value

    @classmethod
    def from_snapshot(cls, value: dict[str, Any]) -> "RuntimeWatchdog":
        if not isinstance(value, dict) or set(value) != {
            "snapshotVersion", "runtimeState", "deadlines", "failure"
        }:
            raise ValueError("watchdog snapshot fields are invalid")
        if value["snapshotVersion"] != cls.SNAPSHOT_VERSION:
            raise ValueError("unsupported watchdog snapshot version")
        if value["runtimeState"] not in cls.STATE_SET:
            raise ValueError("watchdog snapshot runtime state is invalid")
        deadlines = value["deadlines"]
        if not isinstance(deadlines, list):
            raise ValueError("watchdog snapshot deadlines must be an array")

        watchdog = cls()
        watchdog.runtime_state = value["runtimeState"]
        seen_keys: set[str] = set()
        for item in deadlines:
            if not isinstance(item, dict) or set(item) != {
                "key", "code", "atUptimeMs", "relatedMessageId"
            }:
                raise ValueError("watchdog deadline snapshot is malformed")
            key, code, at_ms, related = (
                item["key"], item["code"], item["atUptimeMs"], item["relatedMessageId"]
            )
            if (
                not isinstance(key, str) or not key or key in seen_keys
                or not isinstance(code, str) or not code
                or not isinstance(at_ms, int) or isinstance(at_ms, bool) or at_ms < 0
                or (related is not None and (not isinstance(related, str) or not related))
            ):
                raise ValueError("watchdog deadline snapshot is malformed")
            seen_keys.add(key)
            watchdog._deadlines[key] = _Deadline(key, code, at_ms, related)

        failure = value["failure"]
        if failure is not None:
            if not isinstance(failure, dict) or set(failure) != {
                "code", "detectedAtUptimeMs", "runtimeStateAtFailure",
                "relatedMessageId", "action"
            }:
                raise ValueError("watchdog failure snapshot is malformed")
            detected = failure["detectedAtUptimeMs"]
            related = failure["relatedMessageId"]
            if (
                not isinstance(failure["code"], str) or not failure["code"]
                or not isinstance(detected, int) or isinstance(detected, bool) or detected < 0
                or failure["runtimeStateAtFailure"] not in cls.STATE_SET
                or (related is not None and (not isinstance(related, str) or not related))
                or failure["action"] != "INTERRUPT_EXECUTION_WITHOUT_FORMAL_RESULT"
                or watchdog.runtime_state != "ERROR"
                or watchdog._deadlines
            ):
                raise ValueError("watchdog failure snapshot is inconsistent")
            watchdog._failure = WatchdogFailure(
                failure["code"], detected, failure["runtimeStateAtFailure"],
                related, failure["action"],
            )
        elif watchdog.runtime_state == "ERROR":
            raise ValueError("ERROR watchdog snapshot must carry its terminal failure")

        canonical_bytes(value)
        return watchdog

