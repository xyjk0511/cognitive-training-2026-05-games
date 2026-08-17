from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .canonical import canonical_bytes, canonical_sha256
from .game_schema import GameSchemaError, validate_game_config
from .result_validator import ResultValidationError, validate_game_payload
from .schema import validate_schema
from .wire import parse_runtime_message


class ValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ScheduledBoundary:
    kind: str
    at_ms: int
    correlation_id: str
    clock_revision: int


class FlowValidator:
    """Executable A620-TRC-1.1 Gate 0 reference reducer.

    The reducer deliberately performs more than JSON Schema validation. It
    checks identity isolation, sender-local ordering, idempotency, command
    correlation, clock arithmetic, state echoes, batch evidence reconciliation
    and the result commit handshake.
    """

    COMMAND_ACCEPTED_REQUIRED = {"START", "PAUSE", "RESUME", "TERMINATE"}
    TERMINAL_STATES = {"RESULT_COMMITTED", "TERMINATED", "ERROR"}
    STATE_SET = {
        "UNPREPARED", "PREPARING", "READY", "START_SCHEDULED", "RUNNING",
        "PAUSE_SCHEDULED", "PAUSED", "RESUME_SCHEDULED", "FINALIZING",
        "RESULT_PENDING_COMMIT", "RESULT_COMMITTED", "TERMINATING", "TERMINATED", "ERROR",
    }
    BOUNDARY_PRIORITY = {"TERMINATE": 0, "DEADLINE": 1, "PAUSE": 2, "RESUME": 3, "START": 4}

    def __init__(self) -> None:
        self.state = "UNPREPARED"
        self.identity: dict[str, Any] | None = None
        self.seen_messages: dict[str, bytes] = {}
        self.last_sender_seq = {"ANDROID_CONTROLLER": 0, "COCOS_RUNTIME": 0}
        self.last_sender_uptime = {"ANDROID_CONTROLLER": -1, "COCOS_RUNTIME": -1}

        self.commands: dict[str, dict[str, Any]] = {}
        self.accepted_commands: set[str] = set()
        self.command_accept_deadlines: dict[str, int] = {}
        self.pending_query_commands: set[str] = set()
        self.expected_confirmation: dict[str, str] = {}
        self.boundaries: list[ScheduledBoundary] = []

        self.runtime_config_hash: str | None = None
        self.game_code: str | None = None
        self.design_max_level: int | None = None
        self.planned_batch_count: int | None = None
        self.session_start_level: int | None = None
        self.duration_ms = 300000

        self.clock_revision = 0
        self.cutoff_ms: int | None = None
        self.run_anchor_uptime_ms: int | None = None
        self.run_anchor_active_ms = 0
        self.active_elapsed_ms = 0
        self.deadline_confirmed = False

        self.evidence_ledger: dict[int, str] = {}
        self.last_batch_closed_active_ms = -1
        self.result_ready_message: dict[str, Any] | None = None
        self.result_payload_hash: str | None = None
        self.final_formal_result_id: str | None = None

    def _fail(self, message: str) -> None:
        raise ValidationError(message)

    @staticmethod
    def _base_identity(msg: dict[str, Any]) -> dict[str, Any]:
        return {
            key: msg[key]
            for key in [
                "systemId",
                "deviceId",
                "taskId",
                "taskItemId",
                "executionAttempt",
                "runtimeSessionId",
                "packageVersion",
                "coreProtocolVersion",
                "monotonicEpochId",
            ]
        }

    def _check_identity(self, msg: dict[str, Any]) -> None:
        current = self._base_identity(msg)
        if self.identity is None:
            self.identity = current
        elif current != self.identity:
            self._fail("message identity/version/epoch differs from the active runtime session")

    def _check_replay_and_sequence(self, msg: dict[str, Any]) -> bool:
        message_id = msg["messageId"]
        encoded = canonical_bytes(msg)
        if message_id in self.seen_messages:
            if self.seen_messages[message_id] != encoded:
                self._fail(f"messageId {message_id} was reused with different content")
            return True

        role = msg["senderRole"]
        if msg["senderSeq"] <= self.last_sender_seq[role]:
            self._fail(f"senderSeq is not strictly increasing for {role}")
        if msg["sentAtUptimeMs"] < self.last_sender_uptime[role]:
            self._fail(f"sentAtUptimeMs moved backwards for {role}")
        self.last_sender_seq[role] = msg["senderSeq"]
        self.last_sender_uptime[role] = msg["sentAtUptimeMs"]
        self.seen_messages[message_id] = encoded
        return False

    def _check_command_accept_timeouts(self, now_ms: int, *, inclusive: bool) -> None:
        expired = [
            command_id
            for command_id, deadline in self.command_accept_deadlines.items()
            if (deadline <= now_ms if inclusive else deadline < now_ms)
            and command_id not in self.accepted_commands
        ]
        if expired:
            self._fail(f"COMMAND_ACCEPTED timeout for commands: {sorted(expired)}")

    def _schedule(self, kind: str, at_ms: int, correlation_id: str, revision: int) -> None:
        self.boundaries.append(ScheduledBoundary(kind, at_ms, correlation_id, revision))
        self.boundaries.sort(key=lambda b: (b.at_ms, self.BOUNDARY_PRIORITY.get(b.kind, 99)))

    def _expected_active_at(self, uptime_ms: int) -> int:
        if self.state in {"UNPREPARED", "PREPARING", "READY", "START_SCHEDULED"}:
            return 0
        if self.state in {"PAUSED", "RESUME_SCHEDULED"}:
            return self.active_elapsed_ms
        if self.state in {"FINALIZING", "RESULT_PENDING_COMMIT", "RESULT_COMMITTED"}:
            return self.duration_ms
        if self.run_anchor_uptime_ms is not None and self.state in {"RUNNING", "PAUSE_SCHEDULED", "TERMINATING"}:
            return min(
                self.duration_ms,
                self.run_anchor_active_ms + max(0, uptime_ms - self.run_anchor_uptime_ms),
            )
        return self.active_elapsed_ms

    def _advance_time(self, now_ms: int, *, inclusive: bool = True) -> None:
        pending: list[ScheduledBoundary] = []
        for boundary in self.boundaries:
            due = boundary.at_ms <= now_ms if inclusive else boundary.at_ms < now_ms
            if not due:
                pending.append(boundary)
                continue

            if boundary.kind == "START" and self.state == "START_SCHEDULED":
                self.run_anchor_uptime_ms = boundary.at_ms
                self.run_anchor_active_ms = 0
                self.active_elapsed_ms = 0
                self.state = "RUNNING"
                self.expected_confirmation["STARTED"] = boundary.correlation_id
            elif boundary.kind == "PAUSE" and self.state == "PAUSE_SCHEDULED":
                self.active_elapsed_ms = self._expected_active_at(boundary.at_ms)
                self.run_anchor_uptime_ms = None
                self.run_anchor_active_ms = self.active_elapsed_ms
                self.state = "PAUSED"
                self.expected_confirmation["PAUSED"] = boundary.correlation_id
            elif boundary.kind == "RESUME" and self.state == "RESUME_SCHEDULED":
                self.run_anchor_uptime_ms = boundary.at_ms
                self.run_anchor_active_ms = self.active_elapsed_ms
                self.state = "RUNNING"
                self.expected_confirmation["RESUMED"] = boundary.correlation_id
            elif boundary.kind == "DEADLINE" and self.state == "RUNNING":
                self.active_elapsed_ms = self.duration_ms
                self.run_anchor_uptime_ms = None
                self.run_anchor_active_ms = self.duration_ms
                self.state = "FINALIZING"
            elif boundary.kind == "TERMINATE" and self.state == "TERMINATING":
                self.active_elapsed_ms = self._expected_active_at(boundary.at_ms)
                self.run_anchor_uptime_ms = None
                self.run_anchor_active_ms = self.active_elapsed_ms
                self.state = "TERMINATED"
                self.expected_confirmation["TERMINATED"] = boundary.correlation_id
            elif self.state not in self.TERMINAL_STATES:
                self._fail(f"internal boundary {boundary.kind} is illegal in state {self.state}")
        self.boundaries = pending

    @staticmethod
    def _runtime_config_hash(payload: dict[str, Any]) -> str:
        projection = deepcopy(payload)
        supplied = projection.pop("runtimeConfigHash")
        expected = canonical_sha256(projection)
        if supplied != expected:
            raise ValidationError("PREPARE runtimeConfigHash is not the canonical hash of its runtime configuration")
        return supplied

    def _command(self, msg: dict[str, Any]) -> None:
        message_type = msg["messageType"]
        if message_type != "ACK_RESULT_COMMITTED" and msg["correlationId"] is not None:
            self._fail(f"active command {message_type} must have null correlationId")
        self.commands[msg["messageId"]] = msg
        payload = msg["payload"]
        now = msg["sentAtUptimeMs"]
        if message_type in self.COMMAND_ACCEPTED_REQUIRED:
            self.command_accept_deadlines[msg["messageId"]] = now + 100

        if message_type == "PREPARE":
            if self.state != "UNPREPARED":
                self._fail("PREPARE only legal in UNPREPARED")
            try:
                validate_game_config(payload["gameCode"], payload["gameConfigSchemaId"], payload["gameConfig"])
            except GameSchemaError as exc:
                self._fail(str(exc))
            if not 1 <= payload["sessionStartLevel"] <= payload["designMaxLevel"] <= 10000:
                self._fail("PREPARE levels must satisfy 1 <= sessionStartLevel <= designMaxLevel <= 10000")
            if not 1 <= payload["plannedBatchCount"] <= 1024:
                self._fail("PREPARE plannedBatchCount must be within 1..1024")
            self.runtime_config_hash = self._runtime_config_hash(payload)
            self.game_code = payload["gameCode"]
            self.design_max_level = payload["designMaxLevel"]
            self.planned_batch_count = payload["plannedBatchCount"]
            self.session_start_level = payload["sessionStartLevel"]
            self.duration_ms = payload["durationMs"]
            self.state = "PREPARING"
            return

        if message_type == "START":
            if self.state != "READY":
                self._fail("START only legal in READY")
            lead = payload["effectiveStartUptimeMs"] - now
            if lead < 500 or payload["commandLeadTimeMs"] != lead:
                self._fail("START lead time must equal the declared value and be at least 500 ms")
            if payload["activeElapsedMs"] != 0:
                self._fail("START activeElapsedMs must be zero")
            if payload["cutoffUptimeMs"] != payload["effectiveStartUptimeMs"] + self.duration_ms:
                self._fail("START cutoff does not equal start + duration")
            if payload["clockRevision"] <= self.clock_revision:
                self._fail("clockRevision must increase")
            self.clock_revision = payload["clockRevision"]
            self.cutoff_ms = payload["cutoffUptimeMs"]
            self.deadline_confirmed = False
            self.state = "START_SCHEDULED"
            self._schedule("START", payload["effectiveStartUptimeMs"], msg["messageId"], self.clock_revision)
            self._schedule("DEADLINE", payload["cutoffUptimeMs"], msg["messageId"], self.clock_revision)
            return

        if message_type == "PAUSE":
            if self.state != "RUNNING":
                self._fail("PAUSE only legal in RUNNING")
            lead = payload["effectivePauseUptimeMs"] - now
            if lead < 300 or payload["pauseLeadTimeMs"] != lead:
                self._fail("PAUSE lead time must equal the declared value and be at least 300 ms")
            if self.cutoff_ms is None or payload["effectivePauseUptimeMs"] >= self.cutoff_ms:
                self._fail("PAUSE must become effective strictly before the authoritative deadline")
            expected_active = self._expected_active_at(payload["effectivePauseUptimeMs"])
            if expected_active >= self.duration_ms:
                self._fail("PAUSE cannot displace or follow the active-time deadline")
            if payload["activeElapsedMs"] != expected_active:
                self._fail("PAUSE activeElapsedMs does not match the authoritative clock ledger")
            if payload["clockRevision"] <= self.clock_revision:
                self._fail("clockRevision must increase")
            self.clock_revision = payload["clockRevision"]
            self.state = "PAUSE_SCHEDULED"
            self._schedule("PAUSE", payload["effectivePauseUptimeMs"], msg["messageId"], self.clock_revision)
            # A valid PAUSE is strictly before cutoff, so it may suspend the
            # current deadline. Equal-time PAUSE is rejected above because
            # DEADLINE has higher same-timestamp priority.
            self.boundaries = [boundary for boundary in self.boundaries if boundary.kind != "DEADLINE"]
            self.deadline_confirmed = False
            return

        if message_type == "RESUME":
            if self.state != "PAUSED":
                self._fail("RESUME only legal in PAUSED")
            countdown = payload["resumeInputEnabledUptimeMs"] - now
            if countdown < 3000 or payload["countdownMs"] != countdown:
                self._fail("RESUME countdown must equal the declared value and be at least 3000 ms")
            if payload["activeElapsedMs"] != self.active_elapsed_ms:
                self._fail("RESUME activeElapsedMs differs from the paused clock ledger")
            expected_cutoff = payload["resumeInputEnabledUptimeMs"] + (self.duration_ms - self.active_elapsed_ms)
            if payload["cutoffUptimeMs"] != expected_cutoff:
                self._fail("RESUME cutoff does not match remaining active duration")
            if payload["clockRevision"] <= self.clock_revision:
                self._fail("clockRevision must increase")
            self.clock_revision = payload["clockRevision"]
            self.cutoff_ms = payload["cutoffUptimeMs"]
            self.deadline_confirmed = False
            self.state = "RESUME_SCHEDULED"
            self._schedule("RESUME", payload["resumeInputEnabledUptimeMs"], msg["messageId"], self.clock_revision)
            self._schedule("DEADLINE", payload["cutoffUptimeMs"], msg["messageId"], self.clock_revision)
            return

        if message_type == "DEADLINE":
            if self.state != "FINALIZING":
                self._fail("DEADLINE confirms FINALIZING only")
            if payload["cutoffUptimeMs"] != self.cutoff_ms or payload["clockRevision"] != self.clock_revision:
                self._fail("DEADLINE does not match active clock ledger")
            if payload["activeElapsedMs"] != self.duration_ms:
                self._fail("DEADLINE activeElapsedMs must equal durationMs")
            self.deadline_confirmed = True
            return

        if message_type == "TERMINATE":
            if self.state in self.TERMINAL_STATES:
                self._fail("TERMINATE illegal in terminal state")
            if payload["effectiveTerminateUptimeMs"] < now:
                self._fail("TERMINATE effective time is in the past")
            if payload["clockRevision"] <= self.clock_revision:
                self._fail("clockRevision must increase")
            self.clock_revision = payload["clockRevision"]
            self.state = "TERMINATING"
            self.boundaries.clear()
            self._schedule("TERMINATE", payload["effectiveTerminateUptimeMs"], msg["messageId"], self.clock_revision)
            return

        if message_type == "QUERY_STATE":
            if self.state == "UNPREPARED":
                self._fail("QUERY_STATE illegal in UNPREPARED")
            self.pending_query_commands.add(msg["messageId"])
            return

        if message_type == "ACK_RESULT_COMMITTED":
            if self.state != "RESULT_PENDING_COMMIT" or self.result_ready_message is None:
                self._fail("ACK_RESULT_COMMITTED only legal in RESULT_PENDING_COMMIT")
            if msg["correlationId"] != self.result_ready_message["messageId"]:
                self._fail("ACK correlationId must reference RESULT_READY.messageId")
            if payload["resultPayloadSha256"] != self.result_payload_hash:
                self._fail("ACK result payload hash mismatch")
            if not self.result_ready_message["sentAtUptimeMs"] <= payload["committedAtUptimeMs"] <= now:
                self._fail("ACK committedAtUptimeMs is outside RESULT_READY..ACK interval")
            try:
                committed_utc = datetime.fromisoformat(payload["committedAtUtc"].replace("Z", "+00:00"))
                ack_utc = datetime.fromisoformat(msg["sentAtUtc"].replace("Z", "+00:00"))
            except ValueError as exc:
                self._fail(f"invalid ACK UTC timestamp: {exc}")
            if committed_utc > ack_utc:
                self._fail("committedAtUtc cannot be later than ACK sentAtUtc")
            self.final_formal_result_id = payload["resultId"]
            self.state = "RESULT_COMMITTED"
            return

        self._fail(f"unsupported Android command {message_type}")

    def _event(self, msg: dict[str, Any]) -> None:
        message_type = msg["messageType"]
        payload = msg["payload"]

        if message_type == "READY":
            if self.state != "PREPARING":
                self._fail("READY only legal in PREPARING")
            command = self._correlated_command(msg, "PREPARE")
            if payload["runtimeConfigHash"] != command["payload"]["runtimeConfigHash"]:
                self._fail("READY runtimeConfigHash mismatch")
            if payload["plannedBatchCount"] != command["payload"]["plannedBatchCount"]:
                self._fail("READY plannedBatchCount mismatch")
            if payload["runtimeState"] != "READY":
                self._fail("READY runtimeState mismatch")
            self.state = "READY"
            return

        if message_type == "COMMAND_ACCEPTED":
            command = self._correlated_command(msg, payload["acceptedMessageType"])
            expected_state = {
                "START": "START_SCHEDULED",
                "PAUSE": "PAUSE_SCHEDULED",
                "RESUME": "RESUME_SCHEDULED",
                "TERMINATE": "TERMINATING",
            }[payload["acceptedMessageType"]]
            expected_time_key = {
                "START": "effectiveStartUptimeMs",
                "PAUSE": "effectivePauseUptimeMs",
                "RESUME": "resumeInputEnabledUptimeMs",
                "TERMINATE": "effectiveTerminateUptimeMs",
            }[payload["acceptedMessageType"]]
            if command["messageId"] in self.accepted_commands:
                self._fail("duplicate first-seen COMMAND_ACCEPTED for the same command")
            if self.state != expected_state or payload["runtimeState"] != expected_state:
                self._fail("COMMAND_ACCEPTED runtimeState mismatch")
            if payload["effectiveAtUptimeMs"] != command["payload"][expected_time_key]:
                self._fail("COMMAND_ACCEPTED effective time mismatch")
            if payload["clockRevision"] != command["payload"]["clockRevision"]:
                self._fail("COMMAND_ACCEPTED clockRevision mismatch")
            response_delay = msg["sentAtUptimeMs"] - command["sentAtUptimeMs"]
            if not 0 <= response_delay <= 100:
                self._fail("COMMAND_ACCEPTED exceeded 100 ms timeout or predates command")
            if msg["sentAtUptimeMs"] > payload["effectiveAtUptimeMs"]:
                self._fail("COMMAND_ACCEPTED arrived after its effective boundary")
            if payload["acceptedMessageType"] == "PAUSE" and payload["effectiveAtUptimeMs"] - msg["sentAtUptimeMs"] < 150:
                self._fail("PAUSE acceptance safety margin below 150 ms")
            self.accepted_commands.add(command["messageId"])
            self.command_accept_deadlines.pop(command["messageId"], None)
            return

        if message_type == "STARTED":
            command = self._confirm(msg, "STARTED", "START")
            if self.state != "RUNNING":
                self._fail("STARTED confirmation requires RUNNING")
            if (
                payload["effectiveStartUptimeMs"] != command["payload"]["effectiveStartUptimeMs"]
                or payload["cutoffUptimeMs"] != command["payload"]["cutoffUptimeMs"]
                or payload["clockRevision"] != command["payload"]["clockRevision"]
                or payload["runtimeState"] != "RUNNING"
            ):
                self._fail("STARTED echo mismatch")
            return

        if message_type == "PAUSED":
            command = self._confirm(msg, "PAUSED", "PAUSE")
            if self.state != "PAUSED":
                self._fail("PAUSED confirmation requires PAUSED")
            if (
                payload["effectivePauseUptimeMs"] != command["payload"]["effectivePauseUptimeMs"]
                or payload["activeElapsedMs"] != self.active_elapsed_ms
                or payload["clockRevision"] != command["payload"]["clockRevision"]
                or payload["runtimeState"] != "PAUSED"
            ):
                self._fail("PAUSED echo mismatch")
            return

        if message_type == "RESUMED":
            command = self._confirm(msg, "RESUMED", "RESUME")
            if self.state != "RUNNING":
                self._fail("RESUMED confirmation requires RUNNING")
            if (
                payload["resumeInputEnabledUptimeMs"] != command["payload"]["resumeInputEnabledUptimeMs"]
                or payload["cutoffUptimeMs"] != command["payload"]["cutoffUptimeMs"]
                or payload["activeElapsedMs"] != self.run_anchor_active_ms
                or payload["clockRevision"] != command["payload"]["clockRevision"]
                or payload["runtimeState"] != "RUNNING"
            ):
                self._fail("RESUMED echo mismatch")
            return

        if message_type == "BATCH_CLOSED":
            if self.state != "RUNNING":
                self._fail("BATCH_CLOSED only legal in RUNNING")
            projection = deepcopy(payload)
            supplied = projection.pop("batchPayloadSha256")
            if canonical_sha256(projection) != supplied:
                self._fail("BATCH_CLOSED payload hash is not self-consistent")
            ordinal = payload["batchOrdinal"]
            if ordinal in self.evidence_ledger:
                self._fail("duplicate BATCH_CLOSED ordinal")
            if self.planned_batch_count is not None and not 1 <= ordinal <= self.planned_batch_count:
                self._fail("BATCH_CLOSED ordinal outside planned range")
            if ordinal != len(self.evidence_ledger) + 1:
                self._fail("BATCH_CLOSED ordinals must be contiguous from 1")
            expected_active = self._expected_active_at(msg["sentAtUptimeMs"])
            if not self.last_batch_closed_active_ms < payload["closedAtActiveMs"] <= expected_active:
                self._fail("BATCH_CLOSED closedAtActiveMs is inconsistent with clock/evidence order")
            self.last_batch_closed_active_ms = payload["closedAtActiveMs"]
            self.evidence_ledger[ordinal] = supplied
            return

        if message_type in {"STATE_SNAPSHOT", "HEARTBEAT"}:
            if payload["runtimeState"] != self.state:
                self._fail(f"{message_type} runtimeState does not match reducer")
            if payload["clockRevision"] != self.clock_revision:
                self._fail(f"{message_type} clockRevision does not match reducer")
            if payload["lastAppliedControllerSeq"] != self.last_sender_seq["ANDROID_CONTROLLER"]:
                self._fail(f"{message_type} lastAppliedControllerSeq mismatch")
            if payload["activeElapsedMs"] != self._expected_active_at(msg["sentAtUptimeMs"]):
                self._fail(f"{message_type} activeElapsedMs does not match clock ledger")
            if message_type == "STATE_SNAPSHOT":
                command = self._correlated_command(msg, "QUERY_STATE")
                if command["messageId"] not in self.pending_query_commands:
                    self._fail("duplicate or unsolicited STATE_SNAPSHOT")
                self.pending_query_commands.remove(command["messageId"])
            elif msg["correlationId"] is not None:
                self._fail("HEARTBEAT correlationId must be null")
            return

        if message_type == "RESULT_READY":
            if self.state != "FINALIZING":
                self._fail("RESULT_READY only legal in FINALIZING")
            if not self.deadline_confirmed:
                self._fail("RESULT_READY requires DEADLINE confirmation")
            if msg["correlationId"] is not None:
                self._fail("RESULT_READY correlationId must be null")
            payload_hash = canonical_sha256(payload["gamePayload"])
            if payload["resultDraftSha256"] != payload_hash:
                self._fail("RESULT_READY resultDraftSha256 mismatch")
            try:
                validate_game_payload(
                    payload["gamePayload"],
                    evidence_ledger=self.evidence_ledger,
                    expected_game_code=self.game_code,
                    expected_runtime_config_hash=self.runtime_config_hash,
                    expected_planned_batch_count=self.planned_batch_count,
                    expected_design_max_level=self.design_max_level,
                    expected_session_start_level=self.session_start_level,
                    expected_duration_ms=self.duration_ms,
                )
            except (ResultValidationError, GameSchemaError) as exc:
                self._fail(str(exc))
            self.result_ready_message = msg
            self.result_payload_hash = payload_hash
            self.state = "RESULT_PENDING_COMMIT"
            return

        if message_type == "TERMINATED":
            command = self._confirm(msg, "TERMINATED", "TERMINATE")
            if self.state != "TERMINATED":
                self._fail("TERMINATED confirmation requires terminal state")
            if (
                payload["effectiveTerminateUptimeMs"] != command["payload"]["effectiveTerminateUptimeMs"]
                or payload["reasonCode"] != command["payload"]["reasonCode"]
                or payload["runtimeState"] != "TERMINATED"
            ):
                self._fail("TERMINATED echo mismatch")
            return

        if message_type == "COMMAND_REJECTED":
            self._correlated_command(msg, payload["rejectedMessageType"])
            if payload["runtimeState"] != self.state:
                self._fail("COMMAND_REJECTED runtimeState mismatch")
            self.state = "ERROR"
            self.boundaries.clear()
            return

        if message_type == "RUNTIME_ERROR":
            if msg["correlationId"] is not None:
                self._fail("RUNTIME_ERROR correlationId must be null")
            if self.state in self.TERMINAL_STATES:
                self._fail("RUNTIME_ERROR illegal in terminal state")
            if payload["runtimeState"] != self.state:
                self._fail("RUNTIME_ERROR runtimeState must describe the pre-error state")
            if payload["fatal"] is not True:
                self._fail("public RUNTIME_ERROR is reserved for fatal runtime failures")
            self.active_elapsed_ms = self._expected_active_at(msg["sentAtUptimeMs"])
            self.run_anchor_uptime_ms = None
            self.state = "ERROR"
            self.boundaries.clear()
            return

        self._fail(f"unsupported Cocos event {message_type}")

    def _correlated_command(self, msg: dict[str, Any], expected_type: str) -> dict[str, Any]:
        correlation = msg["correlationId"]
        if correlation is None or correlation not in self.commands:
            self._fail(f"{msg['messageType']} correlationId does not reference a known command")
        command = self.commands[correlation]
        if command["messageType"] != expected_type:
            self._fail(f"{msg['messageType']} references {command['messageType']}, expected {expected_type}")
        return command

    def _confirm(self, msg: dict[str, Any], confirmation_type: str, command_type: str) -> dict[str, Any]:
        command = self._correlated_command(msg, command_type)
        if command["messageId"] not in self.accepted_commands:
            self._fail(f"{confirmation_type} arrived before COMMAND_ACCEPTED")
        if self.expected_confirmation.get(confirmation_type) != command["messageId"]:
            self._fail(f"unexpected {confirmation_type} confirmation")
        self.expected_confirmation.pop(confirmation_type, None)
        return command

    def process_wire(self, raw: bytes | str) -> None:
        self.process(parse_runtime_message(raw))

    def process(self, msg: dict[str, Any]) -> None:
        validate_schema(msg, "a620_training_runtime_message.schema.json")
        self._check_identity(msg)
        if self._check_replay_and_sequence(msg):
            return

        now = msg["sentAtUptimeMs"]
        # An acceptance at exactly command+100ms is legal. Any other message
        # after that boundary exposes the missing acceptance immediately.
        self._check_command_accept_timeouts(now, inclusive=False)

        # TERMINATE wins against a DEADLINE at the same uptime millisecond.
        terminate_preempts = (
            msg["messageType"] == "TERMINATE"
            and self.cutoff_ms is not None
            and msg["payload"]["effectiveTerminateUptimeMs"] <= self.cutoff_ms
            and msg["sentAtUptimeMs"] <= self.cutoff_ms
        )
        if terminate_preempts:
            self._advance_time(msg["sentAtUptimeMs"], inclusive=False)
            self._command(msg)
            self._advance_time(msg["sentAtUptimeMs"], inclusive=True)
            self._check_command_accept_timeouts(now, inclusive=True)
            return

        self._advance_time(msg["sentAtUptimeMs"])
        if msg["senderRole"] == "ANDROID_CONTROLLER":
            self._command(msg)
        else:
            self._event(msg)
        self._check_command_accept_timeouts(now, inclusive=True)

    def snapshot(self) -> dict[str, Any]:
        """Return a canonical-JSON-safe complete reducer checkpoint."""

        return {
            "snapshotVersion": "A620-RSN-1.1",
            "state": self.state,
            "identity": deepcopy(self.identity),
            "seenMessageCanonicalHex": {key: value.hex() for key, value in self.seen_messages.items()},
            "lastSenderSeq": dict(self.last_sender_seq),
            "lastSenderUptimeMs": dict(self.last_sender_uptime),
            "commands": deepcopy(self.commands),
            "acceptedCommands": sorted(self.accepted_commands),
            "commandAcceptDeadlines": dict(self.command_accept_deadlines),
            "pendingQueryCommands": sorted(self.pending_query_commands),
            "expectedConfirmation": dict(self.expected_confirmation),
            "boundaries": [
                {
                    "kind": boundary.kind,
                    "atMs": boundary.at_ms,
                    "correlationId": boundary.correlation_id,
                    "clockRevision": boundary.clock_revision,
                }
                for boundary in self.boundaries
            ],
            "runtimeConfigHash": self.runtime_config_hash,
            "gameCode": self.game_code,
            "designMaxLevel": self.design_max_level,
            "plannedBatchCount": self.planned_batch_count,
            "sessionStartLevel": self.session_start_level,
            "durationMs": self.duration_ms,
            "clockRevision": self.clock_revision,
            "cutoffUptimeMs": self.cutoff_ms,
            "runAnchorUptimeMs": self.run_anchor_uptime_ms,
            "runAnchorActiveMs": self.run_anchor_active_ms,
            "activeElapsedMs": self.active_elapsed_ms,
            "deadlineConfirmed": self.deadline_confirmed,
            "evidenceLedger": {str(key): value for key, value in self.evidence_ledger.items()},
            "lastBatchClosedActiveMs": self.last_batch_closed_active_ms,
            "resultReadyMessage": deepcopy(self.result_ready_message),
            "resultPayloadSha256": self.result_payload_hash,
            "finalFormalResultId": self.final_formal_result_id,
        }

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any]) -> "FlowValidator":
        expected_keys = {
            "snapshotVersion", "state", "identity", "seenMessageCanonicalHex", "lastSenderSeq",
            "lastSenderUptimeMs", "commands", "acceptedCommands", "commandAcceptDeadlines",
            "pendingQueryCommands", "expectedConfirmation", "boundaries", "runtimeConfigHash",
            "gameCode", "designMaxLevel", "plannedBatchCount", "sessionStartLevel", "durationMs",
            "clockRevision", "cutoffUptimeMs", "runAnchorUptimeMs", "runAnchorActiveMs",
            "activeElapsedMs", "deadlineConfirmed", "evidenceLedger", "lastBatchClosedActiveMs",
            "resultReadyMessage", "resultPayloadSha256", "finalFormalResultId",
        }
        if set(snapshot) != expected_keys or snapshot.get("snapshotVersion") != "A620-RSN-1.1":
            raise ValidationError("runtime reducer snapshot has an unsupported shape/version")
        # Canonical validation rejects floats, unsafe integers and malformed
        # Unicode before any state is restored.
        canonical_bytes(snapshot)
        if snapshot["state"] not in cls.STATE_SET:
            raise ValidationError("runtime reducer snapshot contains an unknown state")

        validator = cls()
        validator.state = snapshot["state"]
        validator.identity = deepcopy(snapshot["identity"])
        if validator.identity is not None and set(validator.identity) != {
            "systemId", "deviceId", "taskId", "taskItemId", "executionAttempt",
            "runtimeSessionId", "packageVersion", "coreProtocolVersion", "monotonicEpochId",
        }:
            raise ValidationError("runtime reducer snapshot identity is malformed")

        try:
            validator.seen_messages = {
                key: bytes.fromhex(value) for key, value in snapshot["seenMessageCanonicalHex"].items()
            }
        except (AttributeError, ValueError) as exc:
            raise ValidationError("runtime reducer snapshot message cache is malformed") from exc
        validator.last_sender_seq = dict(snapshot["lastSenderSeq"])
        validator.last_sender_uptime = dict(snapshot["lastSenderUptimeMs"])
        if set(validator.last_sender_seq) != {"ANDROID_CONTROLLER", "COCOS_RUNTIME"}:
            raise ValidationError("runtime reducer snapshot sender sequence map is malformed")
        if set(validator.last_sender_uptime) != {"ANDROID_CONTROLLER", "COCOS_RUNTIME"}:
            raise ValidationError("runtime reducer snapshot sender clock map is malformed")

        validator.commands = deepcopy(snapshot["commands"])
        for command_id, command in validator.commands.items():
            validate_schema(command, "a620_training_runtime_message.schema.json")
            if command["messageId"] != command_id or command["senderRole"] != "ANDROID_CONTROLLER":
                raise ValidationError("runtime reducer snapshot command map is malformed")
        validator.accepted_commands = set(snapshot["acceptedCommands"])
        validator.command_accept_deadlines = {
            str(key): int(value) for key, value in snapshot["commandAcceptDeadlines"].items()
        }
        validator.pending_query_commands = set(snapshot["pendingQueryCommands"])
        validator.expected_confirmation = dict(snapshot["expectedConfirmation"])

        try:
            validator.boundaries = [
                ScheduledBoundary(
                    kind=item["kind"],
                    at_ms=item["atMs"],
                    correlation_id=item["correlationId"],
                    clock_revision=item["clockRevision"],
                )
                for item in snapshot["boundaries"]
            ]
        except (KeyError, TypeError) as exc:
            raise ValidationError("runtime reducer snapshot boundaries are malformed") from exc
        if any(boundary.kind not in cls.BOUNDARY_PRIORITY for boundary in validator.boundaries):
            raise ValidationError("runtime reducer snapshot contains unknown boundary kind")
        if validator.boundaries != sorted(
            validator.boundaries,
            key=lambda boundary: (boundary.at_ms, cls.BOUNDARY_PRIORITY[boundary.kind]),
        ):
            raise ValidationError("runtime reducer snapshot boundaries are not ordered")

        validator.runtime_config_hash = snapshot["runtimeConfigHash"]
        validator.game_code = snapshot["gameCode"]
        validator.design_max_level = snapshot["designMaxLevel"]
        validator.planned_batch_count = snapshot["plannedBatchCount"]
        validator.session_start_level = snapshot["sessionStartLevel"]
        validator.duration_ms = snapshot["durationMs"]
        validator.clock_revision = snapshot["clockRevision"]
        validator.cutoff_ms = snapshot["cutoffUptimeMs"]
        validator.run_anchor_uptime_ms = snapshot["runAnchorUptimeMs"]
        validator.run_anchor_active_ms = snapshot["runAnchorActiveMs"]
        validator.active_elapsed_ms = snapshot["activeElapsedMs"]
        validator.deadline_confirmed = snapshot["deadlineConfirmed"]
        try:
            validator.evidence_ledger = {int(key): value for key, value in snapshot["evidenceLedger"].items()}
        except (TypeError, ValueError) as exc:
            raise ValidationError("runtime reducer snapshot evidence ledger is malformed") from exc
        if sorted(validator.evidence_ledger) != list(range(1, len(validator.evidence_ledger) + 1)):
            raise ValidationError("runtime reducer snapshot evidence ledger is not contiguous")
        validator.last_batch_closed_active_ms = snapshot["lastBatchClosedActiveMs"]
        validator.result_ready_message = deepcopy(snapshot["resultReadyMessage"])
        if validator.result_ready_message is not None:
            validate_schema(validator.result_ready_message, "a620_training_runtime_message.schema.json")
            if validator.result_ready_message["messageType"] != "RESULT_READY":
                raise ValidationError("runtime reducer snapshot resultReadyMessage is malformed")
        validator.result_payload_hash = snapshot["resultPayloadSha256"]
        validator.final_formal_result_id = snapshot["finalFormalResultId"]

        if not 0 <= validator.active_elapsed_ms <= validator.duration_ms:
            raise ValidationError("runtime reducer snapshot activeElapsedMs is invalid")
        if validator.state == "RESULT_COMMITTED" and validator.final_formal_result_id is None:
            raise ValidationError("RESULT_COMMITTED snapshot requires finalFormalResultId")
        return validator

    def finalize(self, expected_outcome: str) -> None:
        expected_state = {
            "COMPLETE": "RESULT_COMMITTED",
            "TERMINATED": "TERMINATED",
            "ERROR": "ERROR",
        }.get(expected_outcome)
        if expected_state is None:
            self._fail(f"unknown expected outcome {expected_outcome}")
        if self.state != expected_state:
            self._fail(f"{expected_outcome.lower()} flow ended in {self.state}")

        missing_accepts = [
            command_id
            for command_id, command in self.commands.items()
            if command["messageType"] in self.COMMAND_ACCEPTED_REQUIRED
            and command_id not in self.accepted_commands
        ]
        if missing_accepts:
            self._fail(f"commands missing COMMAND_ACCEPTED: {missing_accepts}")
        if self.expected_confirmation:
            self._fail(f"missing confirmations: {self.expected_confirmation}")
        if self.pending_query_commands:
            self._fail(f"QUERY_STATE commands missing STATE_SNAPSHOT: {sorted(self.pending_query_commands)}")


def validate_flow(messages: list[dict[str, Any]], expected_outcome: str) -> FlowValidator:
    validator = FlowValidator()
    for message in messages:
        validator.process(message)
    validator.finalize(expected_outcome)
    return validator
