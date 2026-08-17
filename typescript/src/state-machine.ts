import type { RuntimeState } from "./contracts.js";

export type InternalEvent =
  | "EFFECTIVE_START_REACHED"
  | "EFFECTIVE_PAUSE_REACHED"
  | "RESUME_INPUT_BOUNDARY_REACHED"
  | "ACTIVE_TIME_REACHED_DURATION"
  | "TERMINATE_EFFECTIVE_REACHED";

export type ExternalInput =
  | "PREPARE" | "READY" | "START" | "PAUSE" | "RESUME" | "DEADLINE"
  | "RESULT_READY" | "ACK_RESULT_COMMITTED" | "TERMINATE" | "RUNTIME_ERROR"
  | "COMMAND_REJECTED" | "QUERY_STATE" | "BATCH_CLOSED" | "HEARTBEAT"
  | "STATE_SNAPSHOT" | "COMMAND_ACCEPTED" | "STARTED" | "PAUSED"
  | "RESUMED" | "TERMINATED";

const transitions = new Map<string, RuntimeState>([
  ["UNPREPARED|PREPARE", "PREPARING"],
  ["PREPARING|READY", "READY"],
  ["READY|START", "START_SCHEDULED"],
  ["START_SCHEDULED|EFFECTIVE_START_REACHED", "RUNNING"],
  ["RUNNING|PAUSE", "PAUSE_SCHEDULED"],
  ["PAUSE_SCHEDULED|EFFECTIVE_PAUSE_REACHED", "PAUSED"],
  ["PAUSED|RESUME", "RESUME_SCHEDULED"],
  ["RESUME_SCHEDULED|RESUME_INPUT_BOUNDARY_REACHED", "RUNNING"],
  ["RUNNING|ACTIVE_TIME_REACHED_DURATION", "FINALIZING"],
  ["FINALIZING|DEADLINE", "FINALIZING"],
  ["FINALIZING|RESULT_READY", "RESULT_PENDING_COMMIT"],
  ["RESULT_PENDING_COMMIT|ACK_RESULT_COMMITTED", "RESULT_COMMITTED"],
  ["TERMINATING|TERMINATE_EFFECTIVE_REACHED", "TERMINATED"],
]);

const terminalStates = new Set<RuntimeState>(["RESULT_COMMITTED", "TERMINATED", "ERROR"]);
const terminateSources = new Set<RuntimeState>([
  "UNPREPARED", "PREPARING", "READY", "START_SCHEDULED", "RUNNING",
  "PAUSE_SCHEDULED", "PAUSED", "RESUME_SCHEDULED", "FINALIZING", "RESULT_PENDING_COMMIT",
]);
const errorSources = new Set<RuntimeState>([
  "PREPARING", "READY", "START_SCHEDULED", "RUNNING", "PAUSE_SCHEDULED",
  "PAUSED", "RESUME_SCHEDULED", "FINALIZING", "RESULT_PENDING_COMMIT", "TERMINATING",
]);
const heartbeatStates = new Set<RuntimeState>([
  "PREPARING", "READY", "START_SCHEDULED", "RUNNING", "PAUSE_SCHEDULED",
  "PAUSED", "RESUME_SCHEDULED", "FINALIZING", "RESULT_PENDING_COMMIT", "TERMINATING",
]);

function legalNoMutation(state: RuntimeState, input: ExternalInput): boolean {
  switch (input) {
    case "QUERY_STATE": return state !== "UNPREPARED";
    case "STATE_SNAPSHOT": return state !== "UNPREPARED";
    case "HEARTBEAT": return heartbeatStates.has(state);
    case "BATCH_CLOSED": return state === "RUNNING";
    case "COMMAND_ACCEPTED": return ["START_SCHEDULED", "PAUSE_SCHEDULED", "RESUME_SCHEDULED", "TERMINATING"].includes(state);
    case "STARTED": return state === "RUNNING";
    case "PAUSED": return state === "PAUSED";
    case "RESUMED": return state === "RUNNING";
    case "TERMINATED": return state === "TERMINATED";
    default: return false;
  }
}

export function reduceState(state: RuntimeState, input: ExternalInput | InternalEvent): RuntimeState {
  if (input === "TERMINATE" && terminateSources.has(state)) return "TERMINATING";
  if ((input === "RUNTIME_ERROR" || input === "COMMAND_REJECTED") && errorSources.has(state)) return "ERROR";
  if (legalNoMutation(state, input as ExternalInput)) return state;
  const next = transitions.get(`${state}|${input}`);
  if (next) return next;
  if (terminalStates.has(state)) throw new Error(`Terminal state ${state} rejects ${input}`);
  throw new Error(`Illegal transition ${state} + ${input}`);
}
