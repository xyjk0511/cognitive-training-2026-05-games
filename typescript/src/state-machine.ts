import type { RuntimeState } from "./contracts.js";
import {
  GENERATED_NON_MUTATING,
  GENERATED_TERMINAL_STATES,
  GENERATED_TRANSITIONS,
} from "./generated-state-machine.js";

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

function legalNoMutation(state: RuntimeState, input: ExternalInput): boolean {
  return GENERATED_NON_MUTATING.get(input)?.has(state) ?? false;
}

export function reduceState(state: RuntimeState, input: ExternalInput | InternalEvent): RuntimeState {
  if (legalNoMutation(state, input as ExternalInput)) return state;
  const next = GENERATED_TRANSITIONS.get(`${state}|${input}`);
  if (next) return next;
  if (GENERATED_TERMINAL_STATES.has(state)) throw new Error(`Terminal state ${state} rejects ${input}`);
  throw new Error(`Illegal transition ${state} + ${input}`);
}
