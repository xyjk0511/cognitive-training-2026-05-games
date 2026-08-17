from __future__ import annotations
from copy import deepcopy
from dataclasses import dataclass
from typing import Any
from .canonical import canonical_bytes, canonical_sha256
from .schema import validate_schema
from .result_validator import validate_game_payload, ResultValidationError

class ValidationError(ValueError):
    pass

@dataclass
class ScheduledBoundary:
    kind: str
    at_ms: int
    correlation_id: str
    clock_revision: int

class FlowValidator:
    """Executable Gate 0 reference reducer.

    It validates wire structure, identity, sender sequence, message idempotency,
    command correlation, cross-message echoes, internal time boundaries,
    result evidence and terminal outcome.
    """

    COMMAND_ACCEPTED_REQUIRED = {"START","PAUSE","RESUME","TERMINATE"}

    def __init__(self) -> None:
        self.state = "UNPREPARED"
        self.identity: dict[str, Any] | None = None
        self.seen_messages: dict[str, bytes] = {}
        self.last_sender_seq = {"ANDROID_CONTROLLER": 0, "COCOS_RUNTIME": 0}
        self.last_sender_uptime = {"ANDROID_CONTROLLER": -1, "COCOS_RUNTIME": -1}
        self.commands: dict[str, dict[str, Any]] = {}
        self.accepted_commands: set[str] = set()
        self.boundaries: list[ScheduledBoundary] = []
        self.expected_confirmation: dict[str, str] = {}
        self.runtime_config_hash: str | None = None
        self.planned_batch_count: int | None = None
        self.duration_ms = 300000
        self.clock_revision = 0
        self.active_elapsed_ms = 0
        self.cutoff_ms: int | None = None
        self.evidence_ledger: dict[int, str] = {}
        self.result_ready_message: dict[str, Any] | None = None
        self.result_payload_hash: str | None = None
        self.final_formal_result_id: str | None = None
        self.pending_query_commands: set[str] = set()
        self.deadline_confirmed = False
        self.errors: list[str] = []

    def _fail(self, message: str) -> None:
        raise ValidationError(message)

    def _base_identity(self, msg: dict[str, Any]) -> dict[str, Any]:
        return {k: msg[k] for k in ["systemId","deviceId","taskId","taskItemId","executionAttempt","runtimeSessionId","packageVersion","coreProtocolVersion","monotonicEpochId"]}

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

    def _schedule(self, kind: str, at_ms: int, correlation_id: str, revision: int) -> None:
        self.boundaries.append(ScheduledBoundary(kind, at_ms, correlation_id, revision))
        self.boundaries.sort(key=lambda b: (b.at_ms, {"TERMINATE":0,"DEADLINE":1,"PAUSE":2,"RESUME":3,"START":4}.get(b.kind, 9)))

    def _advance_time(self, now_ms: int, *, inclusive: bool = True) -> None:
        pending = []
        for boundary in self.boundaries:
            due = boundary.at_ms <= now_ms if inclusive else boundary.at_ms < now_ms
            if not due:
                pending.append(boundary)
                continue
            if boundary.kind == "START" and self.state == "START_SCHEDULED":
                self.state = "RUNNING"
                self.expected_confirmation["STARTED"] = boundary.correlation_id
            elif boundary.kind == "PAUSE" and self.state == "PAUSE_SCHEDULED":
                self.state = "PAUSED"
                self.expected_confirmation["PAUSED"] = boundary.correlation_id
            elif boundary.kind == "RESUME" and self.state == "RESUME_SCHEDULED":
                self.state = "RUNNING"
                self.expected_confirmation["RESUMED"] = boundary.correlation_id
            elif boundary.kind == "DEADLINE" and self.state == "RUNNING":
                self.active_elapsed_ms = self.duration_ms
                self.state = "FINALIZING"
            elif boundary.kind == "TERMINATE" and self.state == "TERMINATING":
                self.state = "TERMINATED"
                self.expected_confirmation["TERMINATED"] = boundary.correlation_id
            else:
                # Obsolete boundaries after a higher-priority terminal transition are ignored.
                if self.state not in {"TERMINATED","ERROR","RESULT_COMMITTED"}:
                    self._fail(f"internal boundary {boundary.kind} is illegal in state {self.state}")
        self.boundaries = pending

    def _command(self, msg: dict[str, Any]) -> None:
        mt = msg["messageType"]
        if mt != "ACK_RESULT_COMMITTED" and msg["correlationId"] is not None:
            self._fail(f"active command {mt} must have null correlationId")
        self.commands[msg["messageId"]] = msg
        p = msg["payload"]
        now = msg["sentAtUptimeMs"]

        if mt == "PREPARE":
            if self.state != "UNPREPARED": self._fail("PREPARE only legal in UNPREPARED")
            self.runtime_config_hash = p["runtimeConfigHash"]
            self.planned_batch_count = p["plannedBatchCount"]
            self.duration_ms = p["durationMs"]
            self.state = "PREPARING"
            return
        if mt == "START":
            if self.state != "READY": self._fail("START only legal in READY")
            if p["effectiveStartUptimeMs"] - now < 500: self._fail("START lead time below 500 ms")
            if p["cutoffUptimeMs"] != p["effectiveStartUptimeMs"] + self.duration_ms: self._fail("START cutoff does not equal start + duration")
            if p["clockRevision"] <= self.clock_revision: self._fail("clockRevision must increase")
            self.clock_revision = p["clockRevision"]
            self.cutoff_ms = p["cutoffUptimeMs"]
            self.state = "START_SCHEDULED"
            self._schedule("START", p["effectiveStartUptimeMs"], msg["messageId"], self.clock_revision)
            self._schedule("DEADLINE", p["cutoffUptimeMs"], msg["messageId"], self.clock_revision)
            return
        if mt == "PAUSE":
            if self.state != "RUNNING": self._fail("PAUSE only legal in RUNNING")
            if p["effectivePauseUptimeMs"] - now < 300: self._fail("PAUSE lead time below 300 ms")
            if p["clockRevision"] <= self.clock_revision: self._fail("clockRevision must increase")
            self.clock_revision = p["clockRevision"]
            self.active_elapsed_ms = p["activeElapsedMs"]
            self.state = "PAUSE_SCHEDULED"
            self._schedule("PAUSE", p["effectivePauseUptimeMs"], msg["messageId"], self.clock_revision)
            # Existing deadline is invalidated until RESUME supplies a new cutoff.
            self.boundaries = [b for b in self.boundaries if b.kind != "DEADLINE"]
            return
        if mt == "RESUME":
            if self.state != "PAUSED": self._fail("RESUME only legal in PAUSED")
            if p["resumeInputEnabledUptimeMs"] - now < 3000: self._fail("RESUME countdown below 3000 ms")
            if p["cutoffUptimeMs"] != p["resumeInputEnabledUptimeMs"] + (self.duration_ms - p["activeElapsedMs"]): self._fail("RESUME cutoff does not match remaining active duration")
            if p["clockRevision"] <= self.clock_revision: self._fail("clockRevision must increase")
            self.clock_revision = p["clockRevision"]
            self.active_elapsed_ms = p["activeElapsedMs"]
            self.cutoff_ms = p["cutoffUptimeMs"]
            self.state = "RESUME_SCHEDULED"
            self._schedule("RESUME", p["resumeInputEnabledUptimeMs"], msg["messageId"], self.clock_revision)
            self._schedule("DEADLINE", p["cutoffUptimeMs"], msg["messageId"], self.clock_revision)
            return
        if mt == "DEADLINE":
            if self.state != "FINALIZING": self._fail("DEADLINE confirms FINALIZING only")
            if p["cutoffUptimeMs"] != self.cutoff_ms or p["clockRevision"] != self.clock_revision: self._fail("DEADLINE does not match active clock ledger")
            self.deadline_confirmed = True
            return
        if mt == "TERMINATE":
            if self.state in {"RESULT_COMMITTED","TERMINATED","ERROR"}: self._fail("TERMINATE illegal in terminal state")
            if p["effectiveTerminateUptimeMs"] < now: self._fail("TERMINATE effective time is in the past")
            if p["clockRevision"] <= self.clock_revision: self._fail("clockRevision must increase")
            self.clock_revision = p["clockRevision"]
            self.state = "TERMINATING"
            self.boundaries.clear()
            self._schedule("TERMINATE", p["effectiveTerminateUptimeMs"], msg["messageId"], self.clock_revision)
            return
        if mt == "QUERY_STATE":
            if self.state == "UNPREPARED": self._fail("QUERY_STATE illegal in UNPREPARED")
            self.pending_query_commands.add(msg["messageId"])
            return
        if mt == "ACK_RESULT_COMMITTED":
            if self.state != "RESULT_PENDING_COMMIT": self._fail("ACK_RESULT_COMMITTED only legal in RESULT_PENDING_COMMIT")
            if msg["correlationId"] != self.result_ready_message["messageId"]: self._fail("ACK correlationId must reference RESULT_READY.messageId")
            if p["resultPayloadSha256"] != self.result_payload_hash: self._fail("ACK result payload hash mismatch")
            self.final_formal_result_id = p["resultId"]
            self.state = "RESULT_COMMITTED"
            return
        self._fail(f"unsupported Android command {mt}")

    def _event(self, msg: dict[str, Any]) -> None:
        mt = msg["messageType"]
        p = msg["payload"]
        if mt == "READY":
            if self.state != "PREPARING": self._fail("READY only legal in PREPARING")
            command = self._correlated_command(msg, "PREPARE")
            if p["runtimeConfigHash"] != command["payload"]["runtimeConfigHash"]: self._fail("READY runtimeConfigHash mismatch")
            if p["plannedBatchCount"] != command["payload"]["plannedBatchCount"]: self._fail("READY plannedBatchCount mismatch")
            self.state = "READY"
            return
        if mt == "COMMAND_ACCEPTED":
            command = self._correlated_command(msg, p["acceptedMessageType"])
            expected_state = {"START":"START_SCHEDULED","PAUSE":"PAUSE_SCHEDULED","RESUME":"RESUME_SCHEDULED","TERMINATE":"TERMINATING"}[p["acceptedMessageType"]]
            expected_time_key = {"START":"effectiveStartUptimeMs","PAUSE":"effectivePauseUptimeMs","RESUME":"resumeInputEnabledUptimeMs","TERMINATE":"effectiveTerminateUptimeMs"}[p["acceptedMessageType"]]
            if p["runtimeState"] != expected_state: self._fail("COMMAND_ACCEPTED runtimeState mismatch")
            if p["effectiveAtUptimeMs"] != command["payload"][expected_time_key]: self._fail("COMMAND_ACCEPTED effective time mismatch")
            if p["clockRevision"] != command["payload"]["clockRevision"]: self._fail("COMMAND_ACCEPTED clockRevision mismatch")
            if msg["sentAtUptimeMs"] - command["sentAtUptimeMs"] > 100: self._fail("COMMAND_ACCEPTED exceeded 100 ms timeout")
            if p["acceptedMessageType"] == "PAUSE" and p["effectiveAtUptimeMs"] - msg["sentAtUptimeMs"] < 150: self._fail("PAUSE acceptance safety margin below 150 ms")
            self.accepted_commands.add(command["messageId"])
            return
        if mt == "STARTED":
            command = self._confirm(msg, "STARTED", "START")
            if self.state != "RUNNING": self._fail("STARTED confirmation requires RUNNING")
            if p["effectiveStartUptimeMs"] != command["payload"]["effectiveStartUptimeMs"] or p["cutoffUptimeMs"] != command["payload"]["cutoffUptimeMs"] or p["clockRevision"] != command["payload"]["clockRevision"]: self._fail("STARTED echo mismatch")
            return
        if mt == "PAUSED":
            command = self._confirm(msg, "PAUSED", "PAUSE")
            if self.state != "PAUSED": self._fail("PAUSED confirmation requires PAUSED")
            if p["effectivePauseUptimeMs"] != command["payload"]["effectivePauseUptimeMs"] or p["activeElapsedMs"] != command["payload"]["activeElapsedMs"] or p["clockRevision"] != command["payload"]["clockRevision"]: self._fail("PAUSED echo mismatch")
            return
        if mt == "RESUMED":
            command = self._confirm(msg, "RESUMED", "RESUME")
            if self.state != "RUNNING": self._fail("RESUMED confirmation requires RUNNING")
            if p["resumeInputEnabledUptimeMs"] != command["payload"]["resumeInputEnabledUptimeMs"] or p["cutoffUptimeMs"] != command["payload"]["cutoffUptimeMs"] or p["activeElapsedMs"] != command["payload"]["activeElapsedMs"] or p["clockRevision"] != command["payload"]["clockRevision"]: self._fail("RESUMED echo mismatch")
            return
        if mt == "BATCH_CLOSED":
            if self.state != "RUNNING": self._fail("BATCH_CLOSED only legal in RUNNING")
            projection = deepcopy(p); supplied = projection.pop("batchPayloadSha256")
            if canonical_sha256(projection) != supplied: self._fail("BATCH_CLOSED payload hash is not self-consistent")
            ordinal = p["batchOrdinal"]
            if ordinal in self.evidence_ledger: self._fail("duplicate BATCH_CLOSED ordinal")
            if self.planned_batch_count is not None and not 1 <= ordinal <= self.planned_batch_count: self._fail("BATCH_CLOSED ordinal outside planned range")
            if not self.evidence_ledger and ordinal != 1: self._fail("first BATCH_CLOSED ordinal must be 1")
            if self.evidence_ledger and ordinal != max(self.evidence_ledger) + 1: self._fail("BATCH_CLOSED ordinals must be contiguous")
            self.evidence_ledger[ordinal] = supplied
            return
        if mt in {"STATE_SNAPSHOT","HEARTBEAT"}:
            if p["runtimeState"] != self.state: self._fail(f"{mt} runtimeState does not match reducer")
            if p["clockRevision"] != self.clock_revision: self._fail(f"{mt} clockRevision does not match reducer")
            if p["lastAppliedControllerSeq"] != self.last_sender_seq["ANDROID_CONTROLLER"]: self._fail(f"{mt} lastAppliedControllerSeq mismatch")
            if mt == "STATE_SNAPSHOT":
                command = self._correlated_command(msg, "QUERY_STATE")
                if command["messageId"] not in self.pending_query_commands: self._fail("duplicate or unsolicited STATE_SNAPSHOT")
                self.pending_query_commands.remove(command["messageId"])
            elif msg["correlationId"] is not None: self._fail("HEARTBEAT correlationId must be null")
            return
        if mt == "RESULT_READY":
            if self.state != "FINALIZING": self._fail("RESULT_READY only legal in FINALIZING")
            if not self.deadline_confirmed: self._fail("RESULT_READY requires DEADLINE confirmation")
            if msg["correlationId"] is not None: self._fail("RESULT_READY correlationId must be null")
            payload_hash = canonical_sha256(p["gamePayload"])
            if p["resultDraftSha256"] != payload_hash: self._fail("RESULT_READY resultDraftSha256 mismatch")
            try:
                validate_game_payload(p["gamePayload"], evidence_ledger=self.evidence_ledger)
            except ResultValidationError as e:
                self._fail(str(e))
            if p["gamePayload"]["runtimeConfigHash"] != self.runtime_config_hash: self._fail("RESULT_READY runtimeConfigHash mismatch")
            if p["gamePayload"]["plannedBatchCount"] != self.planned_batch_count: self._fail("RESULT_READY plannedBatchCount mismatch")
            self.result_ready_message = msg
            self.result_payload_hash = payload_hash
            self.state = "RESULT_PENDING_COMMIT"
            return
        if mt == "TERMINATED":
            self._confirm(msg, "TERMINATED", "TERMINATE")
            if self.state != "TERMINATED": self._fail("TERMINATED confirmation requires terminal state")
            return
        if mt == "COMMAND_REJECTED":
            self._correlated_command(msg, p["rejectedMessageType"])
            self.state = "ERROR"
            return
        if mt == "RUNTIME_ERROR":
            if msg["correlationId"] is not None: self._fail("RUNTIME_ERROR correlationId must be null")
            if self.state in {"RESULT_COMMITTED","TERMINATED","ERROR"}: self._fail("RUNTIME_ERROR illegal in terminal state")
            self.state = "ERROR"
            self.boundaries.clear()
            return
        self._fail(f"unsupported Cocos event {mt}")

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
        if self.expected_confirmation.get(confirmation_type) != command["messageId"]:
            self._fail(f"unexpected {confirmation_type} confirmation")
        self.expected_confirmation.pop(confirmation_type, None)
        return command

    def process(self, msg: dict[str, Any]) -> None:
        validate_schema(msg, "a620_training_runtime_message.schema.json")
        self._check_identity(msg)
        if self._check_replay_and_sequence(msg):
            return
        # A TERMINATE whose effective time is at or before the known cutoff wins
        # at the same uptime millisecond. Process it before equal-time boundaries.
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
            return
        self._advance_time(msg["sentAtUptimeMs"])
        if msg["senderRole"] == "ANDROID_CONTROLLER":
            self._command(msg)
        else:
            self._event(msg)

    def finalize(self, expected_outcome: str) -> None:
        # Flush boundaries up to the largest representable time only for already terminal-intended flows.
        if expected_outcome == "COMPLETE":
            if self.state != "RESULT_COMMITTED": self._fail(f"complete flow ended in {self.state}")
        elif expected_outcome == "TERMINATED":
            if self.state != "TERMINATED": self._fail(f"terminated flow ended in {self.state}")
        elif expected_outcome == "ERROR":
            if self.state != "ERROR": self._fail(f"error flow ended in {self.state}")
        else:
            self._fail(f"unknown expected outcome {expected_outcome}")
        missing = [cmd_id for cmd_id, cmd in self.commands.items() if cmd["messageType"] in self.COMMAND_ACCEPTED_REQUIRED and cmd_id not in self.accepted_commands]
        if missing:
            self._fail(f"commands missing COMMAND_ACCEPTED: {missing}")
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
