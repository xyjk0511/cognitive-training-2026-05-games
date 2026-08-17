import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalSha256, canonicalString, type JsonValue } from "../canonical.js";
import { reduceState } from "../state-machine.js";
import type { RuntimeState } from "../contracts.js";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), "../contracts/test-vectors/canonical_json_vectors.json"), "utf8")) as Array<{id:string,value:JsonValue,canonicalUtf8:string,sha256:string}>;
for (const v of vectors) {
  assert(canonicalString(v.value) === v.canonicalUtf8, `canonical bytes mismatch: ${v.id}`);
  assert(canonicalSha256(v.value) === v.sha256, `canonical hash mismatch: ${v.id}`);
}
let state: RuntimeState = "UNPREPARED";
state = reduceState(state, "PREPARE");
assert(state === "PREPARING", "PREPARE transition");
let s: any = "PREPARING";
s = reduceState(s, "READY"); s = reduceState(s, "START"); s = reduceState(s, "EFFECTIVE_START_REACHED");
assert(s === "RUNNING", "start flow");
s = reduceState(s, "ACTIVE_TIME_REACHED_DURATION"); s = reduceState(s, "RESULT_READY"); s = reduceState(s, "ACK_RESULT_COMMITTED");
assert(s === "RESULT_COMMITTED", "result flow");
let rejected = false; try { reduceState("RUNNING", "RESULT_READY"); } catch { rejected = true; }
assert(rejected, "RESULT_READY from RUNNING must be rejected");
console.log("TYPESCRIPT_GATE0_TESTS_PASS");
