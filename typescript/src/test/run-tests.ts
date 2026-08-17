import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalSha256, canonicalString, type JsonValue } from "../canonical.js";
import type { RuntimeState } from "../contracts.js";
import { reduceState } from "../state-machine.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertRejected(action: () => unknown, message: string): void {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  assert(rejected, message);
}

const vectors = JSON.parse(
  readFileSync(resolve(process.cwd(), "../contracts/test-vectors/canonical_json_vectors.json"), "utf8"),
) as Array<{id:string,value:JsonValue,canonicalUtf8:string,sha256:string}>;
for (const vector of vectors) {
  assert(canonicalString(vector.value) === vector.canonicalUtf8, `canonical bytes mismatch: ${vector.id}`);
  assert(canonicalSha256(vector.value) === vector.sha256, `canonical hash mismatch: ${vector.id}`);
}
assertRejected(() => canonicalString({ bad: "\ud800" }), "unpaired surrogate must be rejected");
assertRejected(() => canonicalString({ bad: -0 }), "negative zero must be rejected");
assert(canonicalSha256({}) === "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", "pure TypeScript SHA-256 known vector");
const canonicalSource = readFileSync(resolve(process.cwd(), "src/canonical.ts"), "utf8");
assert(!canonicalSource.includes('from "node:crypto"'), "runtime canonicalizer must not import Node crypto");

const stateSpec = JSON.parse(
  readFileSync(resolve(process.cwd(), "../contracts/normative/a620_runtime_state_machine_v1.1.json"), "utf8"),
) as {
  transitions: Array<{from: RuntimeState[]; input: string; to: RuntimeState}>;
  nonMutatingInputLegality: Record<string, RuntimeState[]>;
};
const expectedMatrix = new Map<string, RuntimeState>();
const legalNoMutation = new Set<string>();
const allInputs = new Set<string>();
for (const transition of stateSpec.transitions) {
  allInputs.add(transition.input);
  for (const source of transition.from) {
    const key = `${source}|${transition.input}`;
    assert(!expectedMatrix.has(key) && !legalNoMutation.has(key), `duplicate normative pair: ${key}`);
    expectedMatrix.set(key, transition.to);
  }
}
for (const [input, states] of Object.entries(stateSpec.nonMutatingInputLegality)) {
  allInputs.add(input);
  for (const source of states) {
    const key = `${source}|${input}`;
    assert(!expectedMatrix.has(key) && !legalNoMutation.has(key), `overlapping normative pair: ${key}`);
    legalNoMutation.add(key);
  }
}

// Exhaust every declared state × input pair. Legal entries must reduce to the
// exact normative target; every unspecified pair must reject.
const allStates = [...new Set([
  ...stateSpec.transitions.flatMap(row => [...row.from, row.to]),
  ...Object.values(stateSpec.nonMutatingInputLegality).flat(),
])] as RuntimeState[];
for (const state of allStates) {
  for (const input of allInputs) {
    const key = `${state}|${input}`;
    if (expectedMatrix.has(key)) {
      assert(reduceState(state, input as Parameters<typeof reduceState>[1]) === expectedMatrix.get(key), `generated transition mismatch: ${key}`);
    } else if (legalNoMutation.has(key)) {
      assert(reduceState(state, input as Parameters<typeof reduceState>[1]) === state, `generated non-mutating legality mismatch: ${key}`);
    } else {
      assertRejected(() => reduceState(state, input as Parameters<typeof reduceState>[1]), `unspecified pair must reject: ${key}`);
    }
  }
}

let state: RuntimeState = "UNPREPARED";
state = reduceState(state, "PREPARE");
assert(state === "PREPARING", "PREPARE transition");
let running: RuntimeState = "PREPARING";
running = reduceState(running, "READY");
running = reduceState(running, "START");
running = reduceState(running, "COMMAND_ACCEPTED");
running = reduceState(running, "EFFECTIVE_START_REACHED");
running = reduceState(running, "STARTED");
assert(running === "RUNNING", "start flow");
running = reduceState(running, "BATCH_CLOSED");
running = reduceState(running, "ACTIVE_TIME_REACHED_DURATION");
running = reduceState(running, "DEADLINE");
running = reduceState(running, "RESULT_READY");
running = reduceState(running, "ACK_RESULT_COMMITTED");
assert(running === "RESULT_COMMITTED", "result flow");

assertRejected(() => reduceState("RUNNING", "RESULT_READY"), "RESULT_READY from RUNNING must be rejected");
assertRejected(() => reduceState("UNPREPARED", "QUERY_STATE"), "QUERY_STATE from UNPREPARED must be rejected");
assertRejected(() => reduceState("UNPREPARED", "BATCH_CLOSED"), "BATCH_CLOSED from UNPREPARED must be rejected");
assertRejected(() => reduceState("READY", "COMMAND_ACCEPTED"), "COMMAND_ACCEPTED from READY must be rejected");
assertRejected(() => reduceState("TERMINATING", "TERMINATE"), "repeated TERMINATE while TERMINATING must be rejected");
assert(reduceState("RUNNING", "COMMAND_REJECTED") === "ERROR", "COMMAND_REJECTED must enter ERROR");

console.log("TYPESCRIPT_GATE0_TESTS_PASS");
