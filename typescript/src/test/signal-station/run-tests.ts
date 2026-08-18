import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalSha256, canonicalString } from "../../canonical.js";
import type { EligibleBatch } from "../../contracts.js";
import {
  BATCH_DURATION_MS,
  CUE_DURATION_MS,
  IMPLEMENTED_VERTICAL_SLICE_LEVELS,
  OPERATION_DURATION_MS,
  SESSION_DURATION_MS,
  TIMING_PROFILES,
  VERTICAL_SLICE_RUNTIME_CONFIG,
  WAVE_START_OFFSETS_MS,
  WAVE_TEMPLATES,
  DeterministicActiveClock,
  SignalInstanceRuntime,
  SignalStationHeadlessHarness,
  SignalStationTrainingGameModule,
  buildSignalStationGoldenVectors,
  decideLevelTransition,
  generateBatchPlan,
  getVerticalSliceLevelConfig,
  hasNonColorDifference,
  scoreBatch,
  sharedAttributeCount,
  validateLevelConfig,
  type GeneratedSignalInstance,
  type SignalSymbol,
  type TimingProfileId,
} from "../../games/signal-station/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertRejected(action: () => unknown, message: string): void {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  assert(rejected, message);
}

async function assertRejectedAsync(action: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  assert(rejected, message);
}

function withoutBatchHash(batch: EligibleBatch): Record<string, unknown> {
  const projection: Record<string, unknown> = {...batch};
  delete projection["batchPayloadSha256"];
  return projection;
}

function manualDefinition(requiresDouble: boolean): GeneratedSignalInstance {
  return Object.freeze({
    instanceId: requiresDouble ? "manual-double" : "manual-normal",
    batchOrdinal: 1,
    waveOrdinal: 1,
    role: "TARGET",
    targetCategoryId: "A",
    similarityReferenceTargetCategoryId: null,
    requiresDouble,
    slotIndex: 0,
    row: 0,
    column: 0,
    quadrant: "TOP_LEFT",
    symbol: Object.freeze({contour: "CIRCLE", innerMark: "DOT", directionDeg: 0, colorFamily: "BLUE"}),
    enterStartInBatchMs: CUE_DURATION_MS + 500,
    naturalExitEndInBatchMs: CUE_DURATION_MS + 500 + 2_900,
  });
}

// Frozen phase and timing arithmetic.
assertEqual(BATCH_DURATION_MS, 37_500, "batch duration");
assertEqual(CUE_DURATION_MS + OPERATION_DURATION_MS + 2_000 + 2_500, BATCH_DURATION_MS, "batch phases close");
for (const timingId of ["A", "C", "H"] as const satisfies readonly TimingProfileId[]) {
  const profile = TIMING_PROFILES[timingId];
  assertEqual(profile.enteringMs + profile.activeMs + profile.exitingMs, profile.lifecycleMs, `${timingId} lifecycle`);
  assertEqual(profile.lifecycleMs + profile.gapMs, 3_500, `${timingId} gap closure`);
  assertEqual(WAVE_START_OFFSETS_MS[7]! + profile.lifecycleMs + profile.tailBufferMs, OPERATION_DURATION_MS, `${timingId} tail closure`);

  const definition = {...manualDefinition(false), naturalExitEndInBatchMs: CUE_DURATION_MS + 500 + profile.lifecycleMs};
  const atStart = new SignalInstanceRuntime(definition, 0, profile.enteringMs, profile.activeMs, profile.doubleWindowMs);
  assertEqual(atStart.touch(atStart.enterStartActiveMs, `${timingId}-start`).disposition, "TARGET_HIT", `${timingId} enter start is valid`);
  const beforeEnd = new SignalInstanceRuntime(definition, 0, profile.enteringMs, profile.activeMs, profile.doubleWindowMs);
  assertEqual(beforeEnd.touch(beforeEnd.naturalExitEndActiveMs - 1, `${timingId}-end-minus-one`).disposition, "TARGET_HIT", `${timingId} end-1 is valid`);
  const atEnd = new SignalInstanceRuntime(definition, 0, profile.enteringMs, profile.activeMs, profile.doubleWindowMs);
  assertEqual(atEnd.touch(atEnd.naturalExitEndActiveMs, `${timingId}-end`).disposition, "IGNORED_OUTSIDE_WINDOW", `${timingId} exact end is invalid`);
}

// Double-target state machine, exact boundary, other-instance routing and third-click lock.
const doubleProfile = TIMING_PROFILES.A;
const doubleInstance = new SignalInstanceRuntime(manualDefinition(true), 0, doubleProfile.enteringMs, doubleProfile.activeMs, doubleProfile.doubleWindowMs);
const firstDoubleAt = doubleInstance.enterStartActiveMs + 100;
assertEqual(doubleInstance.touch(firstDoubleAt, "double-first").disposition, "DOUBLE_FIRST", "double first click");
assertEqual(doubleInstance.outcome, "PENDING", "first double click does not add a hit");
assertEqual(doubleInstance.touch(firstDoubleAt + 100, "double-second").disposition, "DOUBLE_COMPLETED", "same-instance second click");
assertEqual(doubleInstance.outcome, "HIT", "double completion outcome");
assertEqual(doubleInstance.touch(firstDoubleAt + 200, "double-third").disposition, "IGNORED_LOCKED", "third click is locked");

const exactBoundary = new SignalInstanceRuntime(manualDefinition(true), 0, doubleProfile.enteringMs, doubleProfile.activeMs, doubleProfile.doubleWindowMs);
const boundaryFirst = exactBoundary.enterStartActiveMs + 10;
exactBoundary.touch(boundaryFirst, "boundary-first");
const secondDeadline = exactBoundary.secondDeadlineActiveMs;
assert(secondDeadline !== null, "double deadline must be established");
assertEqual(exactBoundary.touch(secondDeadline, "boundary-second").disposition, "IGNORED_OUTSIDE_WINDOW", "exact double deadline is invalid");
assertEqual(exactBoundary.outcome, "MISS", "double timeout becomes miss");

const routeHarness = new SignalStationHeadlessHarness({sessionSeed: 79_079, sessionStartLevel: 79});
const routePlan = routeHarness.beginBatchAt(0);
const x2 = routePlan.waves.flatMap(wave => wave.instances).find(instance => instance.requiresDouble);
assert(x2 !== undefined, "L79 must generate a double target");
const sameWaveOther = routePlan.waves[x2.waveOrdinal - 1]!.instances.find(instance => instance.role === "TARGET" && instance.instanceId !== x2.instanceId);
assert(sameWaveOther !== undefined, "double wave must include another target");
const x2FirstTime = x2.enterStartInBatchMs + 10;
assertEqual(routeHarness.tap(x2.instanceId, x2FirstTime, "route-x2-first").disposition, "DOUBLE_FIRST", "x2 enters waiting state");
assertEqual(routeHarness.tap(sameWaveOther.instanceId, x2FirstTime + 1, "route-other").disposition, "TARGET_HIT", "other instance routes independently");
assertEqual(routeHarness.tap(x2.instanceId, x2FirstTime + 2, "route-x2-second").disposition, "DOUBLE_COMPLETED", "waiting x2 still completes");
assertEqual(routeHarness.tap(null, x2FirstTime + 3, "route-blank").disposition, "IGNORED_BLANK", "blank touch is not false touch");
assertEqual(routeHarness.tap(x2.instanceId, x2FirstTime, "route-x2-first").disposition, "IGNORED_DUPLICATE_EVENT", "old duplicate replay is idempotent after later input");

const falseTouchHarness = new SignalStationHeadlessHarness({sessionSeed: 7_700, sessionStartLevel: 7});
const falseTouchPlan = falseTouchHarness.beginBatchAt(0);
const distractor = falseTouchPlan.waves.flatMap(wave => wave.instances).find(instance => instance.role === "DISTRACTOR");
assert(distractor !== undefined, "L7 must generate a distractor");
const distractorTouchAt = distractor.enterStartInBatchMs + 1;
assertEqual(falseTouchHarness.tap(distractor.instanceId, distractorTouchAt, "false-first").disposition, "DISTRACTOR_FALSE_TOUCH", "first distractor touch adds F");
assertEqual(falseTouchHarness.tap(distractor.instanceId, distractorTouchAt + 1, "false-repeat").disposition, "IGNORED_LOCKED", "repeated distractor touch is locked");
falseTouchHarness.advanceToActiveMs(BATCH_DURATION_MS);
const falseTouchDraft = falseTouchHarness.finalizeAtDeadline();
assertEqual(falseTouchDraft.eligibleBatches[0]!.gameBatchMetrics["F"], 1, "one distractor instance contributes at most one F");

const timeoutHarness = new SignalStationHeadlessHarness({sessionSeed: 79_700, sessionStartLevel: 79});
const timeoutPlan = timeoutHarness.beginBatchAt(0);
const timeoutDouble = timeoutPlan.waves.flatMap(wave => wave.instances).find(instance => instance.requiresDouble);
assert(timeoutDouble !== undefined, "L79 timeout test requires a double target");
timeoutHarness.tap(timeoutDouble.instanceId, timeoutDouble.enterStartInBatchMs + 1, "timeout-first");
timeoutHarness.advanceToActiveMs(BATCH_DURATION_MS);
const timeoutDraft = timeoutHarness.finalizeAtDeadline();
assertEqual(timeoutDraft.eligibleBatches[0]!.gameBatchMetrics["timedOutDoubleCount"], 2, "all incomplete L79 double targets are audited as timeout");
assertEqual(timeoutDraft.eligibleBatches[0]!.gameBatchMetrics["F"], 0, "double timeout does not add F");

// Pause freezes active time and therefore the remaining double window.
const clock = new DeterministicActiveClock();
clock.startAt(1_000, 301_000);
clock.advanceTo(2_000);
const frozenDouble = new SignalInstanceRuntime(manualDefinition(true), -2_500, doubleProfile.enteringMs, doubleProfile.activeMs, doubleProfile.doubleWindowMs);
assertEqual(frozenDouble.touch(clock.activeElapsedMs, "frozen-first").disposition, "DOUBLE_FIRST", "frozen double first click");
clock.pauseAt(2_000);
clock.advanceTo(52_000);
assertEqual(clock.activeElapsedMs, 1_000, "pause freezes active elapsed");
const resumedCutoff = 52_000 + (SESSION_DURATION_MS - clock.activeElapsedMs);
clock.resumeAt(52_000, resumedCutoff);
clock.advanceTo(53_199);
assertEqual(frozenDouble.touch(clock.activeElapsedMs, "frozen-second").disposition, "DOUBLE_COMPLETED", "paused wall time does not consume double window");

// Four frozen scoring templates and integer boundaries.
const scoreCases = [
  ["P10_D0", 8, 10, 0, 0, "UPGRADE", 82],
  ["P10_D0", 7, 10, 0, 0, "HOLD", 63],
  ["P10_D0", 6, 10, 0, 0, "FAIL", 54],
  ["P15_D5", 12, 15, 1, 5, "UPGRADE", 82],
  ["P15_D5", 11, 15, 1, 5, "HOLD", 67],
  ["P15_D5", 12, 15, 2, 5, "FAIL", 68],
  ["P20_D5", 16, 20, 1, 5, "UPGRADE", 82],
  ["P20_D5", 14, 20, 1, 5, "HOLD", 65],
  ["P20_D5", 13, 20, 0, 5, "FAIL", 66],
  ["P20_D10", 16, 20, 2, 10, "UPGRADE", 82],
  ["P20_D10", 14, 20, 3, 10, "HOLD", 63],
  ["P20_D10", 13, 20, 0, 10, "FAIL", 66],
] as const;
for (const [template, H, T, F, D, zone, expectedScore] of scoreCases) {
  const decision = scoreBatch(template, H, T, F, D);
  assertEqual(decision.resultZone, zone, `${template} result zone`);
  assertEqual(decision.batchScore, expectedScore, `${template} score`);
}
assertEqual(decideLevelTransition(96, "UPGRADE", 0).levelTransition, "HOLD_MAX", "L96 upper bound");
assertEqual(decideLevelTransition(1, "FAIL", 0).levelTransition, "RETRY", "first L1 failure retries");
assertEqual(decideLevelTransition(1, "FAIL", 1).levelTransition, "HOLD_MIN", "second L1 failure holds minimum");
assertEqual(decideLevelTransition(67, "FAIL", 1).levelTransition, "DOWN", "second non-minimum failure goes down");

// Six representative configurations and generator invariants.
for (const level of IMPLEMENTED_VERTICAL_SLICE_LEVELS) {
  const config = getVerticalSliceLevelConfig(level);
  validateLevelConfig(config);
  const seed = 700_000 + level;
  const planA = generateBatchPlan(config, seed, 1);
  const planB = generateBatchPlan(config, seed, 1);
  assertEqual(canonicalString(planA), canonicalString(planB), `L${level} fixed seed reproduction`);
  assert(canonicalString(planA) !== canonicalString(generateBatchPlan(config, seed + 1, 1)), `L${level} different seed should change content`);
  assertEqual(planA.waves.length, 8, `L${level} wave count`);
  const targetSlots = planA.waves.map(wave => new Set(wave.instances.filter(instance => instance.role === "TARGET").map(instance => instance.slotIndex)));
  for (let index = 2; index < targetSlots.length; index += 1) {
    for (const slot of targetSlots[index]!) {
      assert(!(targetSlots[index - 1]!.has(slot) && targetSlots[index - 2]!.has(slot)), `L${level} target slot repeated for three waves`);
    }
  }
  const targets = planA.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "TARGET");
  const left = targets.filter(instance => instance.quadrant.endsWith("LEFT")).length;
  const right = targets.length - left;
  const top = targets.filter(instance => instance.quadrant.startsWith("TOP")).length;
  const bottom = targets.length - top;
  assert(Math.abs(left - right) <= 2 && Math.abs(top - bottom) <= 2, `L${level} quadrant balance`);
}

const l90 = generateBatchPlan(getVerticalSliceLevelConfig(90), 90_090, 1);
for (const wave of l90.waves) {
  assert(wave.instances.length <= 5, "L90 wave object cap");
  assert(wave.instances.filter(instance => instance.role === "TARGET").length <= 3, "L90 target cap");
  assert(wave.instances.filter(instance => instance.role === "DISTRACTOR").length <= 2, "L90 distractor cap");
  assert(wave.instances.filter(instance => instance.requiresDouble).length <= 1, "L90 double cap");
}
assertEqual(l90.waves.flatMap(wave => wave.instances).filter(instance => instance.targetCategoryId === "A").length, 10, "L90 target A count");
assertEqual(l90.waves.flatMap(wave => wave.instances).filter(instance => instance.targetCategoryId === "B").length, 10, "L90 target B count");
assertEqual(l90.waves.flatMap(wave => wave.instances).filter(instance => instance.requiresDouble).length, 4, "L90 double count");
const expectedL90A = [1, 2, 1, 1, 1, 2, 1, 1];
const expectedL90B = [1, 1, 1, 2, 1, 1, 1, 2];
const expectedL90D = [1, 1, 1, 1, 1, 1, 2, 2];
for (let waveIndex = 0; waveIndex < 8; waveIndex += 1) {
  const instances = l90.waves[waveIndex]!.instances;
  assertEqual(instances.filter(instance => instance.targetCategoryId === "A").length, expectedL90A[waveIndex]!, `L90 wave ${waveIndex + 1} target A count`);
  assertEqual(instances.filter(instance => instance.targetCategoryId === "B").length, expectedL90B[waveIndex]!, `L90 wave ${waveIndex + 1} target B count`);
  assertEqual(instances.filter(instance => instance.role === "DISTRACTOR").length, expectedL90D[waveIndex]!, `L90 wave ${waveIndex + 1} distractor count`);
  assertEqual(instances.filter(instance => instance.requiresDouble).length, [2, 4, 6, 8].includes(waveIndex + 1) ? 1 : 0, `L90 wave ${waveIndex + 1} double count`);
}

function assertSimilarity(planLevel: number, expectedShared: number): void {
  const plan = generateBatchPlan(getVerticalSliceLevelConfig(planLevel), 880_000 + planLevel, 1);
  for (const distractor of plan.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "DISTRACTOR")) {
    const category = distractor.similarityReferenceTargetCategoryId;
    assert(category !== null, "distractor must declare reference target");
    const target = plan.targetCards[category];
    assert(target !== null, "reference target card must exist");
    assertEqual(sharedAttributeCount(distractor.symbol, target), expectedShared, `L${planLevel} shared attribute count`);
    assert(hasNonColorDifference(distractor.symbol, target), `L${planLevel} color cannot be sole cue`);
  }
}
assertSimilarity(90, 1);
assertSimilarity(96, 2);
const l7 = generateBatchPlan(getVerticalSliceLevelConfig(7), 77_007, 1);
for (const distractor of l7.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "DISTRACTOR")) {
  const target = l7.targetCards.A as SignalSymbol;
  assert(distractor.symbol.contour !== target.contour && distractor.symbol.innerMark !== target.innerMark, "tier 1 distractor must be visibly different");
}
const invalidL90 = {...getVerticalSliceLevelConfig(90), doubleCount: 5, doubleWaveOrdinals: [2, 4, 6, 8]};
assertRejected(() => validateLevelConfig(invalidL90), "unsatisfied generation constraints must fail explicitly");
const p20d5Config = {
  ...getVerticalSliceLevelConfig(67),
  timingProfile: "C" as const,
  waveTemplate: "P20_D5" as const,
  targetClassCount: 1 as const,
  targetClassSplit: [20] as const,
  similarityTier: 2 as const,
  doubleCount: 0,
  doubleWaveOrdinals: [] as const,
  maxWaveObjects: 4,
};
validateLevelConfig(p20d5Config);
const p20d5Plan = generateBatchPlan(p20d5Config, 20_005, 1);
assertEqual(p20d5Plan.targetTotal, 20, "P20_D5 generator target total");
assertEqual(p20d5Plan.distractorTotal, 5, "P20_D5 generator distractor total");
assertEqual(p20d5Plan.waves.length, 8, "P20_D5 generator wave count");

// Reaction times are audit-only: changing them does not change score, zone, or transition.
const early = new SignalStationHeadlessHarness({sessionSeed: 910_001, sessionStartLevel: 90});
early.runClosedBatches(1, {targetHits: 14, falseTouches: 3, reactionOffsetMs: 1, doubleSecondGapMs: 1});
const earlyDraft = early.finalizeAtDeadline();
const late = new SignalStationHeadlessHarness({sessionSeed: 910_001, sessionStartLevel: 90});
late.runClosedBatches(1, {targetHits: 14, falseTouches: 3, reactionOffsetMs: 1_000, doubleSecondGapMs: 1});
const lateDraft = late.finalizeAtDeadline();
const earlyBatch = earlyDraft.eligibleBatches[0]!;
const lateBatch = lateDraft.eligibleBatches[0]!;
assertEqual(earlyBatch.batchScore, lateBatch.batchScore, "reaction time cannot change score");
assertEqual(earlyBatch.resultZone, lateBatch.resultZone, "reaction time cannot change result zone");
assertEqual(earlyBatch.levelTransition, lateBatch.levelTransition, "reaction time cannot change transition");
assert(earlyBatch.gameBatchMetrics["reactionTimeTotalMs"] !== lateBatch.gameBatchMetrics["reactionTimeTotalMs"], "reaction audit must record changed timing");

// 0/1/7/8 eligible batches, partial audit and exact final boundary.
for (const eligibleCount of [0, 1, 7, 8]) {
  const draft = SignalStationHeadlessHarness.completeSessionWithEligibleCount(
    {sessionSeed: 990_000 + eligibleCount, sessionStartLevel: 90}, eligibleCount,
  );
  assertEqual(draft.eligibleBatchCount, eligibleCount, `${eligibleCount} eligible count`);
  assertEqual(draft.eligibleBatches.length, eligibleCount, `${eligibleCount} eligible array length`);
  assertEqual(draft.incompleteBatchAudit.length, 0, `${eligibleCount} no implicit partial batch`);
  for (const batch of draft.eligibleBatches) {
    assertEqual(batch.batchPayloadSha256, canonicalSha256(withoutBatchHash(batch)), `batch ${batch.batchOrdinal} hash self-consistency`);
  }
  assert(!("derivedQualityFlag" in draft), "game draft must not report Android-derived quality flag");
}
const partialHarness = new SignalStationHeadlessHarness({sessionSeed: 990_100, sessionStartLevel: 90});
partialHarness.beginPartialBatchAt(290_000);
const partialDraft = partialHarness.finalizeAtDeadline();
assertEqual(partialDraft.eligibleBatchCount, 0, "partial-only session has zero eligible batches");
assertEqual(partialDraft.incompleteBatchAudit.length, 1, "partial-only session has one audit");
assertEqual(partialDraft.incompleteBatchAudit[0]!.cutoffReason, "DEADLINE", "partial audit reason");

const maxHarness = new SignalStationHeadlessHarness({sessionSeed: 960_096, sessionStartLevel: 96});
maxHarness.runClosedBatches(1, {targetHits: 16, falseTouches: 2, reactionOffsetMs: 5, doubleSecondGapMs: 1});
const maxDraft = maxHarness.finalizeAtDeadline();
assertEqual(maxDraft.eligibleBatches[0]!.resultZone, "UPGRADE", "L96 reaches upgrade zone");
assertEqual(maxDraft.eligibleBatches[0]!.levelTransition, "HOLD_MAX", "L96 protects upper bound");
assertEqual(maxDraft.sessionEndLevel, 96, "L96 remains level 96");

// Committed runtime config and golden vectors must be byte-for-byte reproducible.
const committedConfig = JSON.parse(readFileSync(resolve(process.cwd(), "../games/signal-station/configs/vertical-slices/runtime-config.json"), "utf8"));
assertEqual(canonicalString(committedConfig), canonicalString(VERTICAL_SLICE_RUNTIME_CONFIG), "committed runtime config matches TypeScript source");
const committedGolden = JSON.parse(readFileSync(resolve(process.cwd(), "../games/signal-station/golden-vectors/vertical-slices.json"), "utf8"));
assertEqual(canonicalString(committedGolden), canonicalString(buildSignalStationGoldenVectors()), "committed golden vectors reproduce exactly");

// Public SPI can carry the slice without modifying shared files. The game-local adapter is strict even though the
// generic baseline validator retains a test-vector compatibility branch for the historical empty object.
const module = new SignalStationTrainingGameModule();
const runtimeConfigHash = canonicalSha256(VERTICAL_SLICE_RUNTIME_CONFIG);
await assertRejectedAsync(() => module.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 1, sessionStartLevel: 90, durationMs: 300000,
  runtimeConfigHash: canonicalSha256({}), gameConfig: {},
}), "game-local adapter must reject empty placeholder config");
const alteredConfig = {...VERTICAL_SLICE_RUNTIME_CONFIG, fullLevelSetStatus: "READY"};
await assertRejectedAsync(() => module.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 1, sessionStartLevel: 90, durationMs: 300000,
  runtimeConfigHash: canonicalSha256(alteredConfig), gameConfig: alteredConfig as unknown as Readonly<Record<string, unknown>>,
}), "game-local adapter must reject a config outside the frozen vertical slice");
await module.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 1, sessionStartLevel: 90, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
await module.dispose();

const lifecycleModule = new SignalStationTrainingGameModule();
await lifecycleModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 620_001, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
lifecycleModule.onStart(1_000, 301_000);
assertEqual(lifecycleModule.currentPlan()?.level, 1, "adapter exposes the active deterministic plan to the renderer");
lifecycleModule.advanceToUptimeMs(38_500);
assertEqual(lifecycleModule.drainBatchClosedDrafts().length, 1, "adapter emits one closed batch draft");
assertEqual(lifecycleModule.drainBatchClosedDrafts().length, 0, "closed batch draft drain is idempotent");
lifecycleModule.onPause(40_000);
lifecycleModule.onResume(43_000, 304_000);
assertEqual(lifecycleModule.onPointerDown(null, "deadline-input", 304_000).disposition, "IGNORED_OUTSIDE_WINDOW", "exact public deadline input is invalid");
lifecycleModule.onDeadline(304_000);
const lifecycleDraft = lifecycleModule.buildResultDraft();
assertEqual(lifecycleDraft.eligibleBatchCount, 8, "adapter closes all eight batches at active deadline");
assertEqual(lifecycleDraft.gameMetrics["pauseCount"], 1, "adapter records one pause");
assertEqual(lifecycleDraft.gameMetrics["totalPausedUptimeMs"], 3_000, "adapter records paused uptime only");
await lifecycleModule.dispose();

assertEqual(SESSION_DURATION_MS, 300_000, "session duration remains frozen");
assertEqual(WAVE_TEMPLATES.P10_D0.distractorTotal, 0, "D=0 template remains explicit");
console.log("SIGNAL_STATION_VERTICAL_SLICE_TESTS_PASS");
