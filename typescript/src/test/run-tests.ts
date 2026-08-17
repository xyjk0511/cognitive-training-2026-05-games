import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { A620_JSON_RESOURCE_LIMITS, canonicalSha256, canonicalString, type JsonValue } from "../canonical.js";
import { decodeCanonicalPayload, encodeFrame, FrameDecoder, MAX_FRAME_PAYLOAD_BYTES } from "../ipc-frame.js";
import type { RuntimeState } from "../contracts.js";
import { reduceState } from "../state-machine.js";
import { requiredResponses, retainUntilResultCommitted, retryDelayMs } from "../retry-policy.js";

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

// A620-JRP-1 resource limits are enforced before recursive emission.
let deep: unknown = 0;
for (let i = 0; i <= A620_JSON_RESOURCE_LIMITS.maxDepth; i++) deep = [deep];
assertRejected(() => canonicalString(deep), "JSON depth budget must be enforced");
assertRejected(
  () => canonicalString(new Array(A620_JSON_RESOURCE_LIMITS.maxArrayItems + 1).fill(0)),
  "JSON array item budget must be enforced",
);
const cyclic: unknown[] = [];
cyclic.push(cyclic);
assertRejected(() => canonicalString(cyclic), "cyclic JSON values must be rejected");

// A620-IPC-FRAME-1 accepts fragmented and coalesced frames while retaining at
// most one partial payload. A read containing two maximum-size frames must not
// be mistaken for a single oversized internal buffer.
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
const frameA = encodeFrame({a: 1});
const frameB = encodeFrame({b: "捕光行动"});
const fragmented = new FrameDecoder();
assert(fragmented.feed(frameA.slice(0, 1)).length === 0, "partial header must be retained");
assert(fragmented.feed(frameA.slice(1, 5)).length === 0, "partial payload must be retained");
const fragmentResult = fragmented.feed(frameA.slice(5));
assert(fragmentResult.length === 1 && canonicalString(decodeCanonicalPayload(fragmentResult[0]!)) === '{"a":1}', "fragmented frame decode");
fragmented.finish();
const coalesced = new FrameDecoder();
const coalescedResult = coalesced.feed(concatBytes(frameA, frameB));
assert(coalescedResult.length === 2, "coalesced frames must decode in one read");
coalesced.finish();
const trailing = new FrameDecoder();
trailing.feed(frameB.slice(0, frameB.length - 1));
assertRejected(() => trailing.finish(), "trailing partial frame must fail close");
const nonCanonical = new TextEncoder().encode('{"b":2, "a":1}');
assertRejected(() => decodeCanonicalPayload(nonCanonical), "noncanonical payload must be rejected");
assertRejected(() => encodeFrame({blob: "x".repeat(MAX_FRAME_PAYLOAD_BYTES)}), "oversized canonical frame must be rejected");
assert([1,2,3,4,5,6,7,100].map(retryDelayMs).join(",") === "100,250,500,1000,2000,5000,5000,5000", "retry policy vector");
assertRejected(() => retryDelayMs(0), "retry attempts must be positive");
assert(requiredResponses("START").join(",") === "COMMAND_ACCEPTED,STARTED", "START obligations must mirror profile");
assert(requiredResponses("HEARTBEAT").length === 0, "non-durable event must have no response obligation");
assert(retainUntilResultCommitted("BATCH_CLOSED"), "batch evidence must remain until result commit");
assert(!retainUntilResultCommitted("RESULT_READY"), "result draft is response-obligation retained");

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
