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
  isVerticalSliceLevelImplemented,
  roundHalfUpRatio,
  scoreBatch,
  sharedAttributeCount,
  validateLevelConfig,
  validateRuntimeConfig,
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

// RoundHalfUp remains exact at safe-integer extremes; the implementation must
// not rely on remainder*2, which can leave JavaScript's exact integer range.
assertEqual(roundHalfUpRatio(1, 2), 1, "round-half-up exact half");
assertEqual(roundHalfUpRatio(4, 3), 1, "round-half-up below half");
assertEqual(roundHalfUpRatio(5, 3), 2, "round-half-up above half");
const oddSafeDenominator = Number.MAX_SAFE_INTEGER;
const oddHalf = Math.ceil(oddSafeDenominator / 2);
assertEqual(roundHalfUpRatio(oddHalf - 1, oddSafeDenominator), 0, "safe-integer half-minus-one remains down");
assertEqual(roundHalfUpRatio(oddHalf, oddSafeDenominator), 1, "safe-integer exact threshold rounds up");

// Runtime config validation fails closed on missing, extra, or relation-breaking fields.
assert(isVerticalSliceLevelImplemented(1) && isVerticalSliceLevelImplemented(96), "representative levels are implemented");
assert(!isVerticalSliceLevelImplemented(2) && !isVerticalSliceLevelImplemented(0), "non-slice levels are not implemented");
const configClone = JSON.parse(JSON.stringify(VERTICAL_SLICE_RUNTIME_CONFIG)) as Record<string, unknown>;
const missingTiming = JSON.parse(JSON.stringify(configClone)) as Record<string, unknown>;
delete (missingTiming["timingProfiles"] as Record<string, unknown>)["H"];
assertRejected(() => validateRuntimeConfig(missingTiming), "runtime config must reject a missing timing profile cleanly");
const alteredTiming = JSON.parse(JSON.stringify(configClone)) as Record<string, unknown>;
((alteredTiming["timingProfiles"] as Record<string, unknown>)["A"] as Record<string, unknown>)["doubleWindowMs"] = 1_199;
assertRejected(() => validateRuntimeConfig(alteredTiming), "runtime config must reject an altered frozen timing field");
const extraLevelField = JSON.parse(JSON.stringify(configClone)) as Record<string, unknown>;
((extraLevelField["levelConfigs"] as Record<string, unknown>)["1"] as Record<string, unknown>)["unexpected"] = true;
assertRejected(() => validateRuntimeConfig(extraLevelField), "runtime config must reject extra representative-level fields");

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
assertRejected(() => decideLevelTransition(67, "FAIL", 2 as 0 | 1), "invalid failure streak must be rejected at runtime");
assertRejected(() => scoreBatch("UNKNOWN" as never, 1, 1, 0, 0), "unknown wave template must fail explicitly");

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

let deterministicStressPlanCount = 0;
for (const level of IMPLEMENTED_VERTICAL_SLICE_LEVELS) {
  const config = getVerticalSliceLevelConfig(level);
  for (let seedIndex = 0; seedIndex < 256; seedIndex += 1) {
    for (let batchOrdinal = 1; batchOrdinal <= 8; batchOrdinal += 1) {
      const plan = generateBatchPlan(config, seedIndex * 104_729 + level, batchOrdinal);
      deterministicStressPlanCount += 1;
      const quadrantCounts = new Map<string, number>([
        ["TOP_LEFT", 0], ["TOP_RIGHT", 0], ["BOTTOM_LEFT", 0], ["BOTTOM_RIGHT", 0],
      ]);
      for (const target of plan.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "TARGET")) {
        quadrantCounts.set(target.quadrant, (quadrantCounts.get(target.quadrant) ?? 0) + 1);
      }
      const values = [...quadrantCounts.values()];
      assert(Math.max(...values) - Math.min(...values) <= 2, `L${level} four-quadrant stress balance`);
      const targetCards = Object.values(plan.targetCards).filter((value): value is SignalSymbol => value !== null);
      for (const distractor of plan.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "DISTRACTOR")) {
        for (const targetCard of targetCards) {
          assert(hasNonColorDifference(distractor.symbol, targetCard), `L${level} distractor cannot rely on color against any target card`);
        }
      }
    }
  }
}
assertEqual(deterministicStressPlanCount, IMPLEMENTED_VERTICAL_SLICE_LEVELS.length * 256 * 8, "deterministic generator stress-plan count");

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

const invalidResponseHarness = new SignalStationHeadlessHarness({sessionSeed: 7_001, sessionStartLevel: 7});
invalidResponseHarness.beginBatchAt(0);
assertRejected(() => invalidResponseHarness.respondToCurrentBatch({targetHits: 1.5, falseTouches: 0, reactionOffsetMs: 1}), "fractional targetHits must be rejected");
assertRejected(() => invalidResponseHarness.respondToCurrentBatch({targetHits: 1, falseTouches: 0, reactionOffsetMs: 2_900}), "touch exactly at A lifecycle end must be rejected by harness");

const retroactiveStart = new SignalStationHeadlessHarness({sessionSeed: 1_001, sessionStartLevel: 1});
retroactiveStart.advanceToActiveMs(100);
assertRejected(() => retroactiveStart.beginBatchAt(0), "batch cannot start behind the session logical time");

const globalDedup = new SignalStationHeadlessHarness({sessionSeed: 1_002, sessionStartLevel: 1});
globalDedup.beginBatchAt(0);
assertEqual(globalDedup.tap(null, 0, "global-event").disposition, "IGNORED_BLANK", "first blank event is consumed");
globalDedup.advanceToActiveMs(BATCH_DURATION_MS);
globalDedup.beginBatchAt(BATCH_DURATION_MS);
assertEqual(globalDedup.tap(null, BATCH_DURATION_MS, "global-event").disposition, "IGNORED_DUPLICATE_EVENT", "event IDs are idempotent across batch boundaries");

const segmentedHarness = new SignalStationHeadlessHarness({sessionSeed: 90_002, sessionStartLevel: 90});
const segmentedResponse = SignalStationHeadlessHarness.holdResponseForLevel(90);
segmentedHarness.runClosedBatches(1, segmentedResponse);
segmentedHarness.runClosedBatches(1, segmentedResponse);
assertEqual(segmentedHarness.session.eligibleBatchCount, 2, "headless closed-batch helper supports deterministic segmented execution");

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

// Result evidence is detached from mutable callers and frozen at every hashed
// or semantically significant object boundary.
const immutableHarness = new SignalStationHeadlessHarness({sessionSeed: 990_200, sessionStartLevel: 90});
immutableHarness.runClosedBatches(1, SignalStationHeadlessHarness.holdResponseForLevel(90));
const immutableDraft = immutableHarness.finalizeAtDeadline();
const immutableBatch = immutableDraft.eligibleBatches[0]!;
assert(Object.isFrozen(immutableBatch), "eligible batch evidence is frozen");
assert(Object.isFrozen(immutableBatch.gameBatchMetrics), "eligible batch metrics are frozen");
assert(Object.isFrozen(immutableDraft.gameMetrics), "session game metrics are frozen");
assert(Object.isFrozen(immutableDraft.eligibleBatches), "eligible batch evidence array is frozen");
assert(Object.isFrozen(immutableDraft.incompleteBatchAudit), "incomplete audit evidence array is frozen");
assertRejected(() => { immutableBatch.gameBatchMetrics["H"] = 999; }, "batch metrics cannot be mutated after hashing");
assertRejected(() => { immutableDraft.gameMetrics["totalH"] = 999; }, "session metrics cannot be mutated after draft construction");
assertRejected(() => { immutableDraft.eligibleBatches.length = 0; }, "eligible batch array cannot be mutated after draft construction");
assertEqual(immutableHarness.session.buildResultDraft().eligibleBatchCount, 1, "caller array mutation cannot alter session evidence");

const immutablePartialHarness = new SignalStationHeadlessHarness({sessionSeed: 990_201, sessionStartLevel: 90});
immutablePartialHarness.beginPartialBatchAt(290_000);
const immutablePartialDraft = immutablePartialHarness.finalizeAtDeadline();
const immutablePartial = immutablePartialDraft.incompleteBatchAudit[0]!;
assert(Object.isFrozen(immutablePartial), "incomplete audit evidence is frozen");
assert(Object.isFrozen(immutablePartial.partialMetrics), "partial metrics are frozen");
assert(Object.isFrozen(immutablePartialDraft.incompleteBatchAudit), "partial audit array is frozen");
assertRejected(() => { immutablePartial.partialMetrics["H"] = 999; }, "partial metrics cannot be mutated after construction");

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

const prepareGuardModule = new SignalStationTrainingGameModule();
await prepareGuardModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 2, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
await assertRejectedAsync(() => prepareGuardModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 3, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
}), "module must reject a second PREPARE without dispose");
await prepareGuardModule.dispose();

const preStartTerminateModule = new SignalStationTrainingGameModule();
await preStartTerminateModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 4, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
preStartTerminateModule.onTerminate("READY_CANCELLED");
assertRejected(() => preStartTerminateModule.buildResultDraft(), "termination before START must not produce a formal result");
assertRejected(() => preStartTerminateModule.drainBatchClosedDrafts(), "terminated execution must not emit batch drafts");
assertRejected(() => preStartTerminateModule.onTerminate("REPEATED"), "repeated TERMINATE must fail closed");
await preStartTerminateModule.dispose();

const postBatchTerminateModule = new SignalStationTrainingGameModule();
await postBatchTerminateModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 5, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
postBatchTerminateModule.onStart(1_000, 301_000);
postBatchTerminateModule.advanceToUptimeMs(38_500);
postBatchTerminateModule.onTerminate("DISCARDED_AFTER_BATCH");
assertRejected(() => postBatchTerminateModule.drainBatchClosedDrafts(), "termination must suppress undrained BATCH_CLOSED output");
assertRejected(() => postBatchTerminateModule.buildResultDraft(), "termination after an eligible batch must still discard the formal result");
await postBatchTerminateModule.dispose();

// An upgrade from a representative level into an unimplemented neighbour must not crash or substitute a config.
const coverageModule = new SignalStationTrainingGameModule();
await coverageModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 6_201_001, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
coverageModule.onStart(1_000, 301_000);
const coveragePlan = coverageModule.currentPlan();
assert(coveragePlan !== null, "coverage test requires an active L1 plan");
for (const target of coveragePlan.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "TARGET").slice(0, 8)) {
  const sourceUptimeMs = 1_000 + target.enterStartInBatchMs + 1;
  assertEqual(coverageModule.onPointerDown(target.instanceId, `coverage-${target.instanceId}`, sourceUptimeMs).disposition, "TARGET_HIT", "coverage test target hit");
}
coverageModule.advanceToUptimeMs(38_500);
assertEqual(coverageModule.currentPlan(), null, "unimplemented L2 is not silently generated");
assertEqual(coverageModule.coverageBlock()?.blockedLevel, 2, "L1 upgrade is blocked explicitly at L2");
coverageModule.onDeadline(301_000);
const coverageDraft = coverageModule.buildResultDraft();
assertEqual(coverageDraft.eligibleBatchCount, 1, "coverage-blocked session retains the closed eligible batch");
assertEqual(coverageDraft.sessionEndLevel, 2, "coverage-blocked result preserves the actual transition target");
assertEqual(coverageDraft.sessionHighestPresentedLevel, 1, "unimplemented L2 is not reported as presented");
assertEqual(coverageDraft.gameMetrics["verticalSliceCoverageBlocked"], true, "coverage block is present in formal game metrics");
assertEqual(coverageDraft.gameMetrics["verticalSliceBlockedAfterBatchOrdinal"], 1, "coverage block identifies the causing batch");
await coverageModule.dispose();

// The same fail-closed policy applies to a later downward transition.
const downwardCoverageModule = new SignalStationTrainingGameModule();
await downwardCoverageModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 6_296_002, sessionStartLevel: 96, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
downwardCoverageModule.onStart(1_000, 301_000);
downwardCoverageModule.advanceToUptimeMs(38_500);
assertEqual(downwardCoverageModule.currentPlan()?.level, 96, "first L96 failure retries the implemented level");
downwardCoverageModule.advanceToUptimeMs(76_000);
assertEqual(downwardCoverageModule.currentPlan(), null, "unimplemented L95 is not generated after the second failure");
assertEqual(downwardCoverageModule.coverageBlock()?.blockedLevel, 95, "L96 downward transition is blocked explicitly at L95");
assertEqual(downwardCoverageModule.coverageBlock()?.afterBatchOrdinal, 2, "downward block identifies the second batch");
downwardCoverageModule.onDeadline(301_000);
const downwardCoverageDraft = downwardCoverageModule.buildResultDraft();
assertEqual(downwardCoverageDraft.eligibleBatchCount, 2, "downward coverage block retains both closed batches");
assertEqual(downwardCoverageDraft.sessionEndLevel, 95, "downward coverage result preserves the actual L95 transition target");
assertEqual(downwardCoverageDraft.sessionHighestPresentedLevel, 96, "unimplemented L95 is not reported as presented");
await downwardCoverageModule.dispose();

const lifecycleModule = new SignalStationTrainingGameModule();
await lifecycleModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 620_001, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
lifecycleModule.onStart(1_000, 301_000);
assertEqual(lifecycleModule.currentPlan()?.level, 1, "adapter exposes the active deterministic plan to the renderer");
assertRejected(
  () => lifecycleModule.onPointerDown(null, "", 38_500),
  "malformed pointer IDs must be rejected before advancing formal time",
);
assertEqual(lifecycleModule.currentPlan()?.batchOrdinal, 1, "rejected pointer ID does not close the active batch");
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

// A single source-time jump to the cutoff must close all fixed batch boundaries in order.
const deadlineJumpModule = new SignalStationTrainingGameModule();
await deadlineJumpModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 620_003, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
deadlineJumpModule.onStart(1_000, 301_000);
deadlineJumpModule.onDeadline(301_000);
const deadlineJumpDraft = deadlineJumpModule.buildResultDraft();
assertEqual(deadlineJumpDraft.eligibleBatchCount, 8, "one deadline jump closes all eight batches at their exact boundaries");
assertEqual(deadlineJumpDraft.eligibleBatches[7]!.closedAtActiveMs, 300_000, "eighth batch closes at the active-time cutoff");
await deadlineJumpModule.dispose();

const postDeadlineTerminateModule = new SignalStationTrainingGameModule();
await postDeadlineTerminateModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 620_004, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
postDeadlineTerminateModule.onStart(1_000, 301_000);
postDeadlineTerminateModule.onDeadline(301_000);
postDeadlineTerminateModule.onTerminate("RESULT_NOT_COMMITTED");
assertRejected(() => postDeadlineTerminateModule.buildResultDraft(), "TERMINATE after deadline invalidates the uncommitted formal draft");
await postDeadlineTerminateModule.dispose();

const lateInputModule = new SignalStationTrainingGameModule();
await lateInputModule.prepare({
  gameCode: "SIGNAL_STATION", sessionSeed: 620_002, sessionStartLevel: 1, durationMs: 300000,
  runtimeConfigHash, gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
lateInputModule.onStart(1_000, 301_000);
assertEqual(lateInputModule.onPointerDown(null, "post-cutoff-input", 301_001).disposition, "IGNORED_OUTSIDE_WINDOW", "post-cutoff pointer is ignored");
lateInputModule.onDeadline(301_000);
assertEqual(lateInputModule.buildResultDraft().actualTrainingMs, 300_000, "effective cutoff can finalize after a later ignored source timestamp");
await lateInputModule.dispose();

assertEqual(SESSION_DURATION_MS, 300_000, "session duration remains frozen");
assertEqual(WAVE_TEMPLATES.P10_D0.distractorTotal, 0, "D=0 template remains explicit");
console.log("SIGNAL_STATION_VERTICAL_SLICE_TESTS_PASS");
