import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalSha256 } from "../../canonical.js";
import {
  ActiveLogicalClock,
  A620_PUBLIC_RULES_SHA256,
  CATCH_LIGHT_CONFIG_SCHEMA_ID,
  CATCH_LIGHT_GOLDEN_ANCHOR_LEVELS,
  CATCH_LIGHT_QA_SEED,
  CATCH_LIGHT_REQUIREMENT_SHA256,
  CATCH_LIGHT_RUNTIME_SLICE_LEVELS,
  CATCH_LIGHT_SOURCE_WORKBOOK_SHA256,
  CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
  CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256,
  CatchLightBatchRuntime,
  CatchLightGameModule,
  CatchLightSession,
  FruitObjectRuntime,
  FRUIT_CATALOG,
  FRUIT_CONTENT_QUALIFICATION,
  FRUIT_POOLS,
  FRUIT_SIMILARITY_RELATIONS,
  GRID_CATALOG,
  UnsupportedSliceTransitionError,
  XorShift32,
  applyLevelDecision,
  batchScore,
  buildGoldenVectors,
  buildHeadlessEvidence,
  fnv1a32Utf8,
  fruitsAreSimilar,
  generateBatchSchedule,
  isDeepFrozenJson,
  levelConfig,
  parseStrictGameConfig,
  resultZone,
  roundHalfUpFraction,
  seedMaterial,
  validateGeneratedSchedule,
  validateVerticalSliceConfig,
  type CatchLightModuleState,
  type GeneratedBatchSchedule,
  type GeneratedInstance,
} from "../../games/catch-light/index.js";

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

function captureRejected(action: () => unknown, message: string): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error(message);
}

async function assertRejectedAsync(action: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  assert(rejected, message);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rehashSchedule(schedule: GeneratedBatchSchedule): void {
  const projection = jsonClone(schedule) as unknown as Record<string, unknown>;
  delete projection.scheduleSha256;
  schedule.scheduleSha256 = canonicalSha256(projection);
}

function maximumConsecutive(waves: readonly number[]): number {
  if (waves.length === 0) return 0;
  const sorted = [...waves].sort((a, b) => a - b);
  let current = 1;
  let best = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    current = sorted[index] === sorted[index - 1]! + 1 ? current + 1 : 1;
    best = Math.max(best, current);
  }
  return best;
}

function objectInstance(overrides: Partial<GeneratedInstance> = {}): GeneratedInstance {
  return {
    instanceId: "B01-W01-T01",
    waveOrdinal: 1,
    ordinalInWave: 1,
    role: "TARGET",
    fruitId: "APPLE",
    similarityClass: "TARGET",
    slotId: "R1C1",
    edgeEmphasis: false,
    isDouble: false,
    activeStartMs: 100,
    activeDeadlineMs: 1000,
    enterEndMs: 300,
    exitStartMs: 800,
    doubleWindowMs: 0,
    ...overrides,
  };
}

function newSession(level: 1 | 28 | 102 | 120, extra: Partial<ConstructorParameters<typeof CatchLightSession>[0]> = {}): CatchLightSession {
  return new CatchLightSession({
    gameConfig: CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
    runtimeConfigHash: canonicalSha256({kind:"test-session", level, extra:Object.keys(extra).sort()}),
    sessionSeed: CATCH_LIGHT_QA_SEED,
    sessionStartLevel: level,
    ...extra,
  });
}

// Frozen configuration, corrected similarity catalog, provenance, and no fallback.
validateVerticalSliceConfig(CATCH_LIGHT_VERTICAL_SLICE_CONFIG);
assert(isDeepFrozenJson(CATCH_LIGHT_VERTICAL_SLICE_CONFIG), "compiled config is recursively frozen");
assert(isDeepFrozenJson(FRUIT_CATALOG), "fruit catalog is recursively frozen");
assert(isDeepFrozenJson(FRUIT_POOLS), "fruit pools are recursively frozen");
assert(isDeepFrozenJson(FRUIT_SIMILARITY_RELATIONS), "similarity relation catalog is recursively frozen");
assert(isDeepFrozenJson(FRUIT_CONTENT_QUALIFICATION), "fruit content qualification is recursively frozen");
assert(isDeepFrozenJson(GRID_CATALOG), "grid catalog is recursively frozen");
assertEqual(FRUIT_CATALOG.length, 12, "fruit catalog size");
assertEqual(new Set(FRUIT_CATALOG.map(fruit => fruit.fruitId)).size, 12, "fruit ids unique");
assertEqual(new Set(FRUIT_CATALOG.map(fruit => fruit.assetPath)).size, 12, "fruit asset paths unique");
assertEqual(FRUIT_POOLS.FP_CORE_A.length, 6, "CORE_A size");
assertEqual(FRUIT_POOLS.FP_CORE_B.length, 6, "CORE_B size");
assertEqual(FRUIT_POOLS.FP_TRANSFER.length, 12, "TRANSFER size");
assertEqual(FRUIT_SIMILARITY_RELATIONS.filter(relation => relation.authority === "SOURCE_WORKBOOK_CONFIRMED").length, 5, "exact CORE_A source-confirmed relation count");
assertEqual(FRUIT_SIMILARITY_RELATIONS.filter(relation => relation.authority === "ENGINEERING_COMPATIBILITY_UNAPPROVED").length, 6, "explicit CORE_B provisional relation count");
assertEqual(new Set(FRUIT_SIMILARITY_RELATIONS.map(relation => relation.tag)).size, FRUIT_SIMILARITY_RELATIONS.length, "similarity tags are unique");
assertEqual(
  new Set(FRUIT_SIMILARITY_RELATIONS.map(relation => [relation.fruitA, relation.fruitB].sort().join("|"))).size,
  FRUIT_SIMILARITY_RELATIONS.length,
  "similarity pairs are unique regardless of direction",
);
assertEqual(FRUIT_CONTENT_QUALIFICATION.runtimeUseStatus, "HEADLESS_VERTICAL_SLICE_ONLY", "fruit relation runtime scope is headless-only");
assertEqual(FRUIT_CONTENT_QUALIFICATION.productionActivationStatus, "BLOCKED_PENDING_FRUIT_SPRITES_AND_CORE_B_RELATION_APPROVAL", "fruit content blocks production activation");
assertEqual(FRUIT_CONTENT_QUALIFICATION.coreA.relationUseApproved, true, "CORE_A relation table is source-confirmed");
assertEqual(FRUIT_CONTENT_QUALIFICATION.coreB.relationUseApproved, false, "CORE_B compatibility relation table is not product-approved");
assertEqual(FRUIT_CONTENT_QUALIFICATION.coreB.productionGate, "BLOCK_UNTIL_PRODUCT_AND_ART_APPROVE_FINAL_SPRITES_AND_PAIR_MATRIX", "CORE_B production gate is explicit");
for (const fruit of FRUIT_CATALOG) {
  const expectedTags = FRUIT_SIMILARITY_RELATIONS
    .filter(relation => relation.fruitA === fruit.fruitId || relation.fruitB === fruit.fruitId)
    .map(relation => relation.tag)
    .sort();
  assertEqual([...fruit.similarityTags].sort().join(","), expectedTags.join(","), `${fruit.fruitId} tags derive from declared relations`);
}
assert(fruitsAreSimilar("APPLE", "STRAWBERRY"), "workbook color-similar apple/strawberry pair");
assert(fruitsAreSimilar("APPLE", "ORANGE"), "workbook shape-similar apple/orange pair");
assert(!fruitsAreSimilar("APPLE", "BANANA"), "apple/banana remains a clear pair");
assert(!fruitsAreSimilar("APPLE", "GRAPE"), "apple/grape remains a clear pair");
assert(fruitsAreSimilar("PEAR", "BANANA"), "workbook color-similar pear/banana pair");
assert(fruitsAreSimilar("ORANGE", "PEAR"), "workbook color-similar orange/pear pair");
assert(fruitsAreSimilar("STRAWBERRY", "GRAPE"), "workbook texture-similar strawberry/grape pair");
assert(fruitsAreSimilar("STRAWBERRY", "APPLE"), "similarity lookup is symmetric");
assert(fruitsAreSimilar("WATERMELON", "PEACH"), "L120 uses the explicitly provisional CORE_B compatibility mapping");
assertEqual(GRID_CATALOG.length, 4, "grid catalog size");
for (const grid of GRID_CATALOG) {
  assertEqual(grid.slots.length, grid.rows * grid.cols, `${grid.gridId} slot count`);
  assert(grid.slots.every(slot => slot.minHitWidthDp >= 56 && slot.minHitHeightDp >= 56), `${grid.gridId} frozen 56dp minimum hit area`);
}
for (const level of CATCH_LIGHT_VERTICAL_SLICE_CONFIG.levels) {
  assertEqual(level.waveSpacingMs - level.stimulusLifecycleMs, level.interWaveBlankMs, `L${level.level} inter-wave blank invariant`);
  assert(level.interWaveBlankMs >= level.hitFeedbackMs, `L${level.level} hit feedback fits blank`);
}
assertEqual(CATCH_LIGHT_VERTICAL_SLICE_CONFIG.levels.map(level => level.level).join(","), "1,28,67,102,120", "W2 exact vertical-slice level set");
assertEqual(CATCH_LIGHT_RUNTIME_SLICE_LEVELS.join(","), "1,28,102,120", "released W2 runtime slice set");
assertEqual(CATCH_LIGHT_GOLDEN_ANCHOR_LEVELS.join(","), "1,28,67,102,120", "required golden anchor set");
assertEqual(CATCH_LIGHT_VERTICAL_SLICE_CONFIG.gameConfigSchemaId, CATCH_LIGHT_CONFIG_SCHEMA_ID, "formal config schema identity");
assertEqual(CATCH_LIGHT_VERTICAL_SLICE_CONFIG.sourceWorkbookSha256, CATCH_LIGHT_SOURCE_WORKBOOK_SHA256, "source workbook provenance");
assertEqual(CATCH_LIGHT_VERTICAL_SLICE_CONFIG.sourceRequirementSha256, CATCH_LIGHT_REQUIREMENT_SHA256, "v1.5 requirement provenance");
assertEqual(CATCH_LIGHT_VERTICAL_SLICE_CONFIG.publicRulesSha256, A620_PUBLIC_RULES_SHA256, "public v1.3 provenance");
assertEqual(CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256, canonicalSha256(CATCH_LIGHT_VERTICAL_SLICE_CONFIG), "compiled config canonical hash");
assertRejected(() => levelConfig(2), "missing level must not use nearest-level fallback");
assertRejected(() => parseStrictGameConfig({}), "legacy empty config must be rejected by W2 runtime");
const exactRuntimeConfig = jsonClone(CATCH_LIGHT_VERTICAL_SLICE_CONFIG) as unknown as Record<string, unknown>;
const parsedRuntimeConfig = parseStrictGameConfig(exactRuntimeConfig);
assert(isDeepFrozenJson(parsedRuntimeConfig), "accepted runtime config is detached and deeply frozen");
(exactRuntimeConfig.levels as Array<Record<string, unknown>>)[0]!.minTargetHits = 9;
assertEqual(parsedRuntimeConfig.levels[0]!.minTargetHits, 8, "accepted config does not alias caller-owned input");
const workbookDrift = jsonClone(CATCH_LIGHT_VERTICAL_SLICE_CONFIG) as unknown as Record<string, unknown>;
workbookDrift.sourceWorkbookSha256 = "0".repeat(64);
assertRejected(() => parseStrictGameConfig(workbookDrift), "source provenance drift is rejected");
const catalogDrift = jsonClone(CATCH_LIGHT_VERTICAL_SLICE_CONFIG) as unknown as {fruitCatalog:Array<Record<string, unknown>>};
catalogDrift.fruitCatalog[0]!.textureCue = "DRIFT";
assertRejected(() => parseStrictGameConfig(catalogDrift as unknown as Record<string, unknown>), "fruit catalog drift is rejected");
const thresholdDrift = jsonClone(CATCH_LIGHT_VERTICAL_SLICE_CONFIG) as unknown as {levels:Array<Record<string, unknown>>};
thresholdDrift.levels[0]!.minTargetHits = 9;
assertRejected(() => parseStrictGameConfig(thresholdDrift as unknown as Record<string, unknown>), "cross-field threshold drift is rejected");
assertRejected(() => new CatchLightSession({
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
  runtimeConfigHash:CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256,
  sessionSeed:CATCH_LIGHT_QA_SEED,
  sessionStartLevel:67,
}), "L67 is a golden-only anchor, not a released W2 runtime slice");

// FNV-1a32 -> xorshift32 -> unbiased Fisher-Yates deterministic chain.
assertEqual(fnv1a32Utf8(""), 0x811c9dc5, "FNV empty vector");
assertEqual(fnv1a32Utf8("hello"), 0x4f9f2cab, "FNV ASCII vector");
assertEqual(fnv1a32Utf8("捕光行动"), 0xa9ed4b3e, "FNV UTF-8 vector");
assertRejected(() => fnv1a32Utf8("\ud800"), "unpaired UTF-16 surrogate is rejected");
assertRejected(() => seedMaterial("BAD|KEY", 1, 1, 0), "seed key separator is rejected");
assertRejected(() => seedMaterial("KEY", 1, 1, 9), "wave ordinal outside 0..8 is rejected");
assertRejected(() => new XorShift32(-1), "negative xorshift seed is rejected");
assertRejected(() => new XorShift32(0x1_0000_0000), "xorshift seed above uint32 is rejected");
const xs = new XorShift32(1);
assertEqual([xs.nextUint32(), xs.nextUint32(), xs.nextUint32()].join(","), "270369,67634689,2647435461", "xorshift32 vector");
const zeroSeed = new XorShift32(0);
assertEqual(zeroSeed.nextUint32(), 1085196063, "zero-state replacement vector");

// Golden schedules plus replay-based anti-forgery validation.
const expectedScheduleHashes = new Map<number, string>([
  [1, "7eafab5ef0448cd85e7d03232c82a829554967d52f6701c44d7e941a79803fb0"],
  [28, "3da6a8ef14427913442d36203a1e4744df3a3fa29ee5c3c769be6a4bff299d9d"],
  [67, "d76ede7bac05e78a04a569d6d450ff0541052ffe2843456f47654b54536b6c90"],
  [102, "8625fc898d381fa0f09d3144113ee5569002fe87529c842b8209548184c2fdb5"],
  [120, "9e9fef308e995b5e4ebbd1ddbff64fb57eea12f3e50c66740f3556add5d06d6c"],
]);
for (const [level, expectedHash] of expectedScheduleHashes) {
  const a = generateBatchSchedule(level, CATCH_LIGHT_QA_SEED, 1);
  const b = generateBatchSchedule(level, CATCH_LIGHT_QA_SEED, 1);
  validateGeneratedSchedule(a);
  assert(isDeepFrozenJson(a), `L${level} schedule is deeply frozen`);
  assertEqual(canonicalSha256(a), canonicalSha256(b), `L${level} deterministic schedule`);
  assertEqual(a.scheduleSha256, expectedHash, `L${level} golden schedule hash`);
  assert(a.scheduleSha256 !== generateBatchSchedule(level, CATCH_LIGHT_QA_SEED, 2).scheduleSha256, `L${level} batch ordinal changes schedule`);
  assert(a.waves.every(wave => wave.instances.length <= a.sameScreenCap), `L${level} same-screen cap`);
  assert(a.waves.every(wave => wave.instances.filter(instance => instance.role === "DISTRACTOR").every((instance, index, list) => list.findIndex(other => other.fruitId === instance.fruitId) === index)), `L${level} distractor uniqueness per wave`);
}

// Stress exactly 1,800 released/anchor schedules: 5 levels × 45 fixed seeds ×
// 8 batch ordinals. This remains deterministic and cheap enough for every CI run.
const replayStressSeeds = [...Array.from({length:44}, (_, index) => index), CATCH_LIGHT_QA_SEED];
for (const level of CATCH_LIGHT_GOLDEN_ANCHOR_LEVELS) {
  for (const sessionSeed of replayStressSeeds) {
    for (let batchOrdinal = 1; batchOrdinal <= 8; batchOrdinal += 1) {
      const schedule = generateBatchSchedule(level, sessionSeed, batchOrdinal);
      validateGeneratedSchedule(schedule);
      assertEqual(schedule.scheduleSha256, generateBatchSchedule(level, sessionSeed, batchOrdinal).scheduleSha256, `L${level}/S${sessionSeed}/B${batchOrdinal} replay`);
    }
  }
}

const l102 = generateBatchSchedule(102, CATCH_LIGHT_QA_SEED, 1);
const l102DoubleWaves = l102.waves.filter(wave => wave.instances.some(instance => instance.isDouble)).map(wave => wave.waveOrdinal);
assertEqual(l102DoubleWaves.length, 2, "L102 double count");
assert(l102.firstTeachingBatchWaveOneDoubleSuppressed, "L102 B1 records teaching suppression");
assert(!l102DoubleWaves.includes(1), "L102 first teaching batch wave one excludes double target");
assert(maximumConsecutive(l102DoubleWaves) <= 2, "L102 follows MAX2_CONSEC rather than permanent separation");
let laterL102UsesWaveOne = false;
for (let seed = 0; seed < 256 && !laterL102UsesWaveOne; seed += 1) {
  for (let batchOrdinal = 2; batchOrdinal <= 8; batchOrdinal += 1) {
    const schedule = generateBatchSchedule(102, seed, batchOrdinal, {firstFormalTeachingBatch:false});
    if (schedule.waves[0]!.instances.some(instance => instance.isDouble)) {
      laterL102UsesWaveOne = true;
      break;
    }
  }
}
assert(laterL102UsesWaveOne, "L102 wave one is available again after the first teaching batch");
const l120 = generateBatchSchedule(120, CATCH_LIGHT_QA_SEED, 1);
assertEqual(l120.waves.flatMap(wave => wave.instances).filter(instance => instance.isDouble).length, 6, "L120 six doubles");
assertEqual(Math.max(...l120.waves.map(wave => wave.instances.length)), 5, "L120 hard same-screen cap");
assert(maximumConsecutive(l120.waves.filter(wave => wave.instances.some(instance => instance.isDouble)).map(wave => wave.waveOrdinal)) <= 3, "L120 MAX3_CONSEC");

// Swap two same-edge, non-primary slots, recompute the schedule hash, and prove
// replay validation still rejects the otherwise constraint-valid forgery.
const forged = jsonClone(generateBatchSchedule(120, CATCH_LIGHT_QA_SEED, 3));
let swapped = false;
for (const wave of forged.waves) {
  for (let left = 1; left < wave.instances.length && !swapped; left += 1) {
    for (let right = left + 1; right < wave.instances.length; right += 1) {
      const a = wave.instances[left]!;
      const b = wave.instances[right]!;
      if (a.edgeEmphasis === b.edgeEmphasis) {
        const slot = a.slotId;
        a.slotId = b.slotId;
        b.slotId = slot;
        swapped = true;
        break;
      }
    }
  }
  if (swapped) break;
}
assert(swapped, "found a semantics-preserving slot swap for anti-forgery test");
rehashSchedule(forged);
const forgedProjection = jsonClone(forged) as unknown as Record<string, unknown>;
delete forgedProjection.scheduleSha256;
assertEqual(forged.scheduleSha256, canonicalSha256(forgedProjection), "forged schedule carries an internally consistent recomputed hash");
assertRejected(() => validateGeneratedSchedule(forged), "deterministic replay rejects rehashed semantic tampering");

// Half-open object windows, monotonic time, snapshots, and duplicate suppression.
assertEqual(new FruitObjectRuntime(objectInstance()).touch(99).disposition, "IGNORED_BEFORE_WINDOW", "touch before active window");
assertEqual(new FruitObjectRuntime(objectInstance()).touch(100).disposition, "TARGET_HIT", "touch at active start");
assertEqual(new FruitObjectRuntime(objectInstance()).touch(999).disposition, "TARGET_HIT", "touch one ms before deadline");
assertEqual(new FruitObjectRuntime(objectInstance()).touch(1000).disposition, "IGNORED_AT_OR_AFTER_DEADLINE", "touch at exact deadline");
const exactDeadlineObject = new FruitObjectRuntime(objectInstance());
assertEqual(exactDeadlineObject.touch(1000).disposition, "IGNORED_AT_OR_AFTER_DEADLINE", "first exact-deadline touch is rejected by the boundary");
assertEqual(exactDeadlineObject.touch(1000).disposition, "IGNORED_AT_OR_AFTER_DEADLINE", "repeated exact-deadline touch remains a boundary rejection, not a duplicate hit");
assertRejected(() => new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1600})), "double window above the 1500ms product ceiling is rejected");
assertRejected(() => new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1250})), "double window outside 100ms product steps is rejected");
const monotonicObject = new FruitObjectRuntime(objectInstance());
monotonicObject.advanceTo(500);
assertRejected(() => monotonicObject.advanceTo(499), "object runtime rejects backward active time");
const repeated = new FruitObjectRuntime(objectInstance());
assertEqual(repeated.touch(100).hitDelta, 1, "first target touch increments H");
assertEqual(repeated.touch(100).disposition, "IGNORED_SAME_TIMESTAMP", "same-object simultaneous second finger ignored");
assertEqual(repeated.touch(101).disposition, "IGNORED_ALREADY_SETTLED", "repeat after settlement ignored");
const callerOwnedInstance = objectInstance();
const detachedObject = new FruitObjectRuntime(callerOwnedInstance);
callerOwnedInstance.fruitId = "BANANA";
assertEqual(detachedObject.instance.fruitId, "APPLE", "object runtime detaches caller-owned instance metadata");
assert(isDeepFrozenJson(detachedObject.instance), "retained object instance metadata is recursively frozen");

const double = new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1200,activeStartMs:0,activeDeadlineMs:5000,enterEndMs:200,exitStartMs:4800}));
assertEqual(double.touch(1000).disposition, "DOUBLE_FIRST", "double first touch");
const firstTouchSnapshot = double.presentationSnapshotAt(1000);
assert(isDeepFrozenJson(firstTouchSnapshot), "object presentation snapshot is frozen");
assertEqual(firstTouchSnapshot.doubleProgress, 1, "snapshot exposes first-touch progress");
assertEqual(firstTouchSnapshot.secondDeadlineOperationMs, 2200, "snapshot exposes second-touch deadline");
assertEqual(double.touch(1000).disposition, "IGNORED_SAME_TIMESTAMP", "double same-timestamp second finger ignored");
assertEqual(double.touch(1001).disposition, "DOUBLE_COMPLETED", "double second sequential touch");
assertEqual(double.presentationSnapshotAt(1001).doubleProgress, 2, "snapshot exposes double completion");
assertEqual(double.touch(1002).disposition, "IGNORED_ALREADY_SETTLED", "double third touch ignored");
const doubleDeadline = new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1200,activeStartMs:0,activeDeadlineMs:5000,enterEndMs:200,exitStartMs:4800}));
assertEqual(doubleDeadline.touch(1000).disposition, "DOUBLE_FIRST", "double deadline setup");
assertEqual(doubleDeadline.touch(2200).disposition, "IGNORED_AT_OR_AFTER_DEADLINE", "second touch exact double deadline invalid");
assertEqual(doubleDeadline.visualPhaseAt(2200), "ACTIVE", "double timeout keeps natural on-screen retreat instead of hit feedback");
assertEqual(doubleDeadline.visualPhaseAt(4800), "EXITING", "double timeout follows natural exit phase");
assertEqual(doubleDeadline.visualPhaseAt(5000), "GONE", "double timeout is gone at lifecycle deadline");
assertEqual(doubleDeadline.auditAt(5000).outcome, "TIMEOUT", "double first-only becomes timeout");
const naturalMiss = new FruitObjectRuntime(objectInstance());
assertEqual(naturalMiss.visualPhaseAt(1000), "GONE", "ordinary miss has no 300ms hit-feedback phase");
const hitFeedback = new FruitObjectRuntime(objectInstance());
hitFeedback.touch(100);
assertEqual(hitFeedback.visualPhaseAt(399), "FEEDBACK", "successful hit keeps 300ms feedback");
assertEqual(hitFeedback.visualPhaseAt(400), "GONE", "successful hit feedback is half-open at 300ms");

// Clock contracts: exact cutoff, rollback rejection, pause exclusion, and late frames.
assertRejected(() => new ActiveLogicalClock().start(1000, 301001), "initial cutoff must be exactly start+300000");
const pausedClock = new ActiveLogicalClock();
pausedClock.start(1000, 301000);
const exactCutoffPauseClock = new ActiveLogicalClock();
exactCutoffPauseClock.start(1000, 301000);
assertRejected(() => exactCutoffPauseClock.pause(301000), "pause at exact authoritative cutoff is rejected");
assertEqual(exactCutoffPauseClock.state, "RUNNING", "rejected exact-cutoff pause leaves clock running");
const pausedDouble = new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1200,activeStartMs:0,activeDeadlineMs:5000,enterEndMs:200,exitStartMs:4800}));
assertEqual(pausedDouble.touch(pausedClock.activeElapsedAt(2000)).disposition, "DOUBLE_FIRST", "double first before pause");
assertEqual(pausedClock.pause(2100), 1100, "pause freezes accumulated active time");
assertRejected(() => pausedClock.resume(5000, 303899), "resume rejects an inconsistent remaining-duration cutoff");
assertEqual(pausedClock.state, "PAUSED", "invalid resume does not mutate clock state");
assertRejected(() => pausedClock.deadline(301000), "paused clock cannot satisfy active-duration deadline");
assertEqual(pausedClock.state, "PAUSED", "invalid paused deadline does not seal clock");
pausedClock.resume(5000, 303900);
assertEqual(pausedDouble.touch(pausedClock.activeElapsedAt(6099)).disposition, "DOUBLE_COMPLETED", "double completes after pause with frozen window");
const exactClock = new ActiveLogicalClock();
exactClock.start(1000, 301000);
const exactDouble = new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1200,activeStartMs:0,activeDeadlineMs:5000,enterEndMs:200,exitStartMs:4800}));
exactDouble.touch(exactClock.activeElapsedAt(2000));
exactClock.pause(2100);
exactClock.resume(5000, 303900);
assertEqual(exactDouble.touch(exactClock.activeElapsedAt(6100)).disposition, "IGNORED_AT_OR_AFTER_DEADLINE", "pause-adjusted exact second deadline invalid");
const lateFrameClock = new ActiveLogicalClock();
lateFrameClock.start(1000, 301000);
assertEqual(lateFrameClock.activeElapsedAt(301001), 300000, "late frame clamps to active deadline");
assertEqual(lateFrameClock.deadline(301000), 300000, "authoritative deadline survives a previously observed late frame");
assertEqual(lateFrameClock.activeElapsedAt(301000), 300000, "sealed clock accepts an authoritative-cutoff snapshot after a prior late frame");

// Different objects at one millisecond are independent; unknown/blank touches do not add F.
const l28Config = levelConfig(28);
const l28Schedule = generateBatchSchedule(l28Config, CATCH_LIGHT_QA_SEED, 1);
const l28Batch = new CatchLightBatchRuntime({batchOrdinal:1,batchStartActiveMs:0,levelBefore:28,consecutiveFailBefore:0,levelConfig:l28Config,schedule:l28Schedule});
const callerOwnedLevel = jsonClone(l28Config);
const callerOwnedSchedule = jsonClone(l28Schedule);
const detachedBatch = new CatchLightBatchRuntime({batchOrdinal:1,batchStartActiveMs:0,levelBefore:28,consecutiveFailBefore:0,levelConfig:callerOwnedLevel,schedule:callerOwnedSchedule});
callerOwnedLevel.minTargetHits = 999;
callerOwnedSchedule.targetTotal = 999;
assertEqual(detachedBatch.levelConfig.minTargetHits, 12, "batch runtime detaches caller-owned level configuration");
assertEqual(detachedBatch.schedule.targetTotal, 15, "batch runtime detaches caller-owned schedule evidence");
const firstWaveTarget = l28Schedule.waves[0]!.instances.find(instance => instance.role === "TARGET")!;
const firstWaveDistractor = l28Schedule.waves[0]!.instances.find(instance => instance.role === "DISTRACTOR")!;
const sameMs = l28Batch.operationStartActiveMs + firstWaveTarget.activeStartMs;
l28Batch.touchBlank(sameMs);
assertEqual(l28Batch.falseTouchCount, 0, "blank touch does not add F");
assertEqual(l28Batch.touchInstance("NO_SUCH_INSTANCE", sameMs).disposition, "IGNORED_WRONG_INSTANCE_PHASE", "unknown object is ignored");
assertEqual(l28Batch.objectTouchCount, 0, "unknown object is not counted as an object touch");
assertEqual(l28Batch.touchInstance(firstWaveTarget.instanceId, sameMs).disposition, "TARGET_HIT", "same-ms target valid");
assertEqual(l28Batch.touchInstance(firstWaveDistractor.instanceId, sameMs).disposition, "DISTRACTOR_FALSE_TOUCH", "different object same-ms distractor valid");
assertEqual(l28Batch.hitCount, 1, "same-ms H count");
assertEqual(l28Batch.falseTouchCount, 1, "same-ms F count");
assertEqual(l28Batch.touchInstance(firstWaveDistractor.instanceId, sameMs).disposition, "IGNORED_SAME_TIMESTAMP", "distractor duplicate suppressed");
assertEqual(l28Batch.falseTouchCount, 1, "distractor only counts once");
const waveSnapshot = l28Batch.snapshotAt(sameMs);
assert(isDeepFrozenJson(waveSnapshot), "batch snapshot is recursively frozen");
assertEqual(waveSnapshot.phase, "OPERATION", "snapshot phase");
assertEqual(waveSnapshot.currentWaveOrdinal, 1, "snapshot current wave");
assert(waveSnapshot.visibleObjects.length > 0, "snapshot exposes visible object presentations");

// Partial audit and authoritative sealing.
const partialBeforeWaveBatch = new CatchLightBatchRuntime({batchOrdinal:1,batchStartActiveMs:0,levelBefore:28,consecutiveFailBefore:0,levelConfig:l28Config,schedule:l28Schedule});
const beforeWave = partialBeforeWaveBatch.partialMetricsAt(partialBeforeWaveBatch.operationStartActiveMs);
assertEqual(beforeWave.waveOrdinal, 0, "partial audit before first wave");
assertEqual(beforeWave.presentedTargetCount, 0, "no target presented before first wave");
assertEqual(beforeWave.unresolvedTargetCount, 0, "unpresented targets are not unresolved");
const partialFirstWaveBatch = new CatchLightBatchRuntime({batchOrdinal:1,batchStartActiveMs:0,levelBefore:28,consecutiveFailBefore:0,levelConfig:l28Config,schedule:l28Schedule});
const firstWavePartial = partialFirstWaveBatch.partialMetricsAt(partialFirstWaveBatch.operationStartActiveMs + l28Config.firstWaveMs);
assertEqual(firstWavePartial.waveOrdinal, 1, "partial audit at first-wave onset");
assert(firstWavePartial.presentedTargetCount > 0, "first wave presents targets");
assertEqual(firstWavePartial.unresolvedTargetCount, firstWavePartial.presentedTargetCount, "only presented untouched targets are unresolved");
const sealedBatch = new CatchLightBatchRuntime({batchOrdinal:1,batchStartActiveMs:0,levelBefore:28,consecutiveFailBefore:0,levelConfig:l28Config,schedule:l28Schedule});
const sealedAt = sealedBatch.operationStartActiveMs + l28Config.firstWaveMs;
const sealedOne = sealedBatch.sealIncompleteAt(sealedAt);
const sealedTwo = sealedBatch.sealIncompleteAt(sealedAt);
assertEqual(canonicalSha256(sealedOne), canonicalSha256(sealedTwo), "sealed incomplete evidence is idempotent");
assertEqual(sealedBatch.touchInstance(firstWaveTarget.instanceId, sealedAt).disposition, "IGNORED_WRONG_INSTANCE_PHASE", "sealed batch rejects further touch mutation");
assertRejected(() => sealedBatch.advanceToSessionActive(sealedAt + 1), "sealed batch cannot advance beyond authoritative cutoff");
const closedForPartialGuard = new CatchLightBatchRuntime({batchOrdinal:1,batchStartActiveMs:0,levelBefore:28,consecutiveFailBefore:0,levelConfig:l28Config,schedule:l28Schedule});
closedForPartialGuard.close(closedForPartialGuard.closeAtActiveMs);
assertRejected(() => closedForPartialGuard.partialMetricsAt(closedForPartialGuard.closeAtActiveMs), "closed batch cannot emit competing partial evidence");

// Session cutoff, first-teaching semantics, snapshots, and unsupported transitions.
function delayedCutoffSession(): CatchLightSession {
  return new CatchLightSession({
    gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
    runtimeConfigHash:canonicalSha256({kind:"cutoff-boundary"}),
    sessionSeed:CATCH_LIGHT_QA_SEED,
    sessionStartLevel:1,
    batchStartDelaysMs:[280000],
  });
}
const beforeCutoffSession = delayedCutoffSession();
beforeCutoffSession.advanceToActive(299999);
const beforeCutoffBatch = beforeCutoffSession.currentBatchView!;
assert(isDeepFrozenJson(beforeCutoffBatch), "current batch inspection view is recursively frozen");
assertRejected(() => {
  (beforeCutoffBatch.schedule as unknown as {targetTotal:number}).targetTotal = 999;
}, "current batch inspection view cannot mutate the session schedule");
const liveAtCutoffTarget = beforeCutoffBatch.schedule.waves.flatMap(wave => wave.instances).find(instance => {
  const operationMs = 299999 - beforeCutoffBatch.operationStartActiveMs;
  return instance.role === "TARGET" && instance.activeStartMs <= operationMs && operationMs < instance.activeDeadlineMs;
});
assert(liveAtCutoffTarget !== undefined, "delayed batch has a target live at 299999ms");
assertEqual(beforeCutoffSession.touchInstance(liveAtCutoffTarget.instanceId, 299999).disposition, "TARGET_HIT", "299999ms touch remains eligible");
const exactCutoffSession = delayedCutoffSession();
exactCutoffSession.advanceToActive(299999);
assertEqual(exactCutoffSession.touchInstance(liveAtCutoffTarget.instanceId, 300000).disposition, "IGNORED_WRONG_INSTANCE_PHASE", "300000ms touch is excluded");
assertRejected(() => delayedCutoffSession().advanceToActive(300001), "300001ms active time is outside the formal domain");

assertRejected(() => new CatchLightSession({
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
  runtimeConfigHash:canonicalSha256({kind:"invalid-delay"}),
  sessionSeed:CATCH_LIGHT_QA_SEED,
  sessionStartLevel:1,
  batchStartDelaysMs:[300001],
}), "headless-only batch delay cannot exceed the full session duration");

const l102Session = newSession(102);
l102Session.advanceToActive(0);
assert(l102Session.currentBatchView!.schedule.firstTeachingBatchWaveOneDoubleSuppressed, "L102 first formal batch suppresses wave-one double");
l102Session.advanceToActive(37500);
assertEqual(l102Session.currentBatchView!.batchOrdinal, 2, "L102 first FAIL retries into B2");
assert(!l102Session.currentBatchView!.schedule.firstTeachingBatchWaveOneDoubleSuppressed, "L102 retry batch does not repeat teaching suppression");
const previouslyIntroducedL102 = newSession(102, {previouslyIntroducedLevels:[102]});
previouslyIntroducedL102.advanceToActive(0);
assert(!previouslyIntroducedL102.currentBatchView!.schedule.firstTeachingBatchWaveOneDoubleSuppressed, "persisted L102 guide history disables repeated teaching suppression");
assertRejected(() => newSession(102, {previouslyIntroducedLevels:[102,102]}), "duplicate persisted guide levels are rejected");
assertRejected(() => newSession(102, {previouslyIntroducedLevels:[0]}), "out-of-range persisted guide levels are rejected");
const sessionSnapshot = l102Session.snapshotAtActive(37500);
assert(isDeepFrozenJson(sessionSnapshot), "session snapshot is recursively frozen");
assertEqual(sessionSnapshot.nextBatchOrdinal, 2, "session snapshot exposes next/current batch ordinal");
assertEqual(sessionSnapshot.consecutiveFail, 1, "session snapshot exposes fail streak");
assertEqual(sessionSnapshot.pendingBatchNotificationCount, 0, "session snapshot exposes pending evidence count");
assertEqual(sessionSnapshot.pendingBatchNotificationHashes.length, 0, "session snapshot exposes an empty pending-evidence hash set");

const unsupported = newSession(28);
// Hit enough targets and at most one distractor to force L28 -> L29, which is
// deliberately absent from the released W2 vertical slices.
unsupported.advanceToActive(0);
const unsupportedBatch = unsupported.currentBatchView!;
const upgradeTargets = unsupportedBatch.schedule.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "TARGET").slice(0, 12);
for (const instance of upgradeTargets) unsupported.touchInstance(instance.instanceId, unsupportedBatch.operationStartActiveMs + instance.activeStartMs);
const unsupportedError = captureRejected(
  () => unsupported.advanceToActive(37500),
  "transition into an unimplemented neighboring level must fail explicitly",
);
assert(unsupportedError instanceof UnsupportedSliceTransitionError, "unsupported transition uses the typed slice-boundary error");
assertEqual(unsupportedError.fromLevel, 28, "typed slice-boundary error records source level");
assertEqual(unsupportedError.toLevel, 29, "typed slice-boundary error records unavailable destination level");
assertEqual(unsupportedError.batchOrdinal, 2, "typed slice-boundary error records the batch that could not be started");
assert(unsupported.closedBatches[0]!.levelAfter === 29, "unsupported transition still preserves the closed batch evidence");
assert(unsupported.closedBatches[0] !== undefined, "closed evidence remains queryable after explicit slice stop");

// External evidence sink failure is retryable without duplicate closing/scoring.
let callbackShouldFail = true;
let callbackCalls = 0;
const deliveredHashes: string[] = [];
const attemptedHashes: string[] = [];
const callbackSession = newSession(1, {
  onBatchClosed: batch => {
    callbackCalls += 1;
    attemptedHashes.push(batch.batchPayloadSha256);
    if (callbackShouldFail) throw new Error("synthetic sink failure");
    deliveredHashes.push(batch.batchPayloadSha256);
  },
});
callbackSession.advanceToActive(0);
assertRejected(() => callbackSession.advanceToActive(37500), "callback failure surfaces to integration layer");
assertEqual(callbackSession.closedBatches.length, 1, "batch closes exactly once before callback failure");
assertEqual(callbackSession.pendingBatchNotificationCount, 1, "failed callback leaves one pending event");
const pendingSnapshot = callbackSession.snapshot();
assertEqual(pendingSnapshot.pendingBatchNotificationHashes.length, 1, "failed callback snapshot exposes one pending hash");
assertEqual(pendingSnapshot.pendingBatchNotificationHashes[0], callbackSession.closedBatches[0]!.batchPayloadSha256, "pending hash identifies the already committed batch evidence");
assertEqual(callbackSession.currentBatchView, null, "closed batch is not retained as current after sink failure");
assertRejected(() => callbackSession.advanceToActive(300001), "invalid time is rejected while a callback is pending");
assertEqual(callbackCalls, 1, "invalid time does not trigger callback retry side effects");
callbackShouldFail = false;
callbackSession.retryPendingBatchNotifications();
assertEqual(callbackCalls, 2, "pending callback is explicitly retried once");
assertEqual(attemptedHashes[0], attemptedHashes[1], "at-least-once retry preserves the exact immutable batch hash");
assertEqual(callbackSession.pendingBatchNotificationCount, 0, "successful retry drains pending queue");
assertEqual(deliveredHashes.length, 1, "one evidence event is delivered");
callbackSession.advanceToActive(37500);
assertEqual(callbackSession.closedBatches.length, 1, "retry does not duplicate closed batch");
assertEqual(callbackSession.currentBatchView!.batchOrdinal, 2, "session resumes from the next batch after retry");

let reentryBlocked = false;
let callbackMutationBlocked = false;
let callbackViewFrozen = false;
let guardedCallbackSession: CatchLightSession;
guardedCallbackSession = newSession(1, {
  onBatchClosed: batch => {
    callbackViewFrozen = isDeepFrozenJson(batch);
    callbackMutationBlocked = Boolean(captureRejected(() => {
      (batch as unknown as {batchScore:number}).batchScore = 999;
    }, "callback batch mutation must fail"));
    reentryBlocked = Boolean(captureRejected(
      () => guardedCallbackSession.snapshot(),
      "BATCH_CLOSED callback must not re-enter session methods",
    ));
  },
});
guardedCallbackSession.advanceToActive(0);
guardedCallbackSession.advanceToActive(37500);
assert(callbackViewFrozen, "BATCH_CLOSED callback receives recursively frozen evidence");
assert(callbackMutationBlocked, "BATCH_CLOSED callback cannot mutate retained evidence");
assert(reentryBlocked, "BATCH_CLOSED callback re-entry is rejected");
assertEqual(guardedCallbackSession.pendingBatchNotificationCount, 0, "guarded callback completes without leaving a pending event");
const detachedClosedView = guardedCallbackSession.closedBatches;
assertRejected(() => {
  (detachedClosedView[0] as unknown as {batchScore:number}).batchScore = 999;
}, "closed-batch inspection copy is immutable");
assert(detachedClosedView[0] !== guardedCallbackSession.closedBatches[0], "closed-batch inspection is detached from retained session state");

// Integer-only decision boundaries, D=0 safety, and validation guards.
assertEqual(roundHalfUpFraction(1, 2), 1, "RoundHalfUp exact half");
assertEqual(roundHalfUpFraction(1, 3), 0, "RoundHalfUp below half");
assertEqual(roundHalfUpFraction(2, 3), 1, "RoundHalfUp above half");
assertRejected(() => roundHalfUpFraction(1, 0), "RoundHalfUp rejects zero denominator");
assertEqual(resultZone(8,10,0,0), "UPGRADE", "D0 80 percent upgrade");
assertEqual(resultZone(7,10,0,0), "HOLD", "D0 70 percent hold");
assertEqual(resultZone(6,10,0,0), "FAIL", "D0 below 70 fail");
assertEqual(batchScore(8,10,0,0), 82, "D0 score vector");
assertEqual(resultZone(12,15,1,5), "UPGRADE", "D5 F1 upgrade");
assertEqual(resultZone(12,15,2,5), "HOLD", "D5 F2 hold");
assertEqual(resultZone(12,15,3,5), "FAIL", "D5 F3 fail");
assertEqual(batchScore(12,15,1,5), 82, "D5 score vector");
assertEqual(resultZone(20,25,2,10), "UPGRADE", "D10 F2 upgrade");
assertEqual(resultZone(20,25,3,10), "HOLD", "D10 F3 hold");
assertEqual(resultZone(20,25,4,10), "FAIL", "D10 F4 fail");
assertEqual(batchScore(20,25,2,10), 82, "D10 score vector");
assertRejected(() => resultZone(11, 10, 0, 0), "H cannot exceed T");
assertRejected(() => resultZone(8, 10, 1, 0), "F cannot exceed D");
assertRejected(() => batchScore(8, 10, 0, 0, "BROKEN" as never), "runtime result-zone validation rejects invalid cast");
assertRejected(() => batchScore(8, 10, 0, 0, "HOLD"), "batch score rejects a valid-but-inconsistent supplied result zone");
assertEqual(applyLevelDecision(10,"UPGRADE",1).levelTransition, "UP", "upgrade clears fail and advances");
assertEqual(applyLevelDecision(120,"UPGRADE",0).levelTransition, "HOLD_MAX", "L120 upper guard");
assertEqual(applyLevelDecision(10,"HOLD",1).consecutiveFailAfter, 0, "hold clears fail streak");
assertEqual(applyLevelDecision(10,"FAIL",0).levelTransition, "RETRY", "first fail retries");
assertEqual(applyLevelDecision(10,"FAIL",1).levelTransition, "DOWN", "second fail descends");
assertEqual(applyLevelDecision(1,"FAIL",1).levelTransition, "HOLD_MIN", "L1 lower guard");
assertRejected(() => applyLevelDecision(0, "HOLD", 0), "level decision rejects level zero");

// Complete headless vertical slices and 0/1/7/8 eligible-batch cutoffs.
const evidence = buildHeadlessEvidence();
const byName = new Map(evidence.map(item => [item.name, item]));
for (const name of ["L1-HOLD-8","L1-FAIL-8","L28-HOLD-8","L102-HOLD-8","L120-UPGRADE-8","L28-HOLD-0","L28-HOLD-1","L28-HOLD-7"]) {
  assert(byName.has(name), `missing headless evidence ${name}`);
}
for (const item of evidence) {
  assert(isDeepFrozenJson(item), `${item.name} headless result is deeply frozen`);
  assertEqual(item.payload.eligibleBatchCount, item.eligibleBatchTarget, `${item.name} eligible count`);
  assertEqual(item.payload.sessionRawScore, item.payload.eligibleBatches.reduce((sum, batch) => sum + batch.batchScore, 0), `${item.name} score excludes incomplete batch`);
  const aggregate = item.payload.gameMetrics;
  assertEqual(aggregate.passEngineType, "PE-EVENT", `${item.name} pass engine`);
  assertEqual(aggregate.pauseCount, 0, `${item.name} headless pause count`);
  assertEqual(aggregate.totalPausedDurationMs, 0, `${item.name} headless paused duration`);
  assertEqual(aggregate.H, item.payload.eligibleBatches.reduce((sum, batch) => sum + batch.gameBatchMetrics.H, 0), `${item.name} aggregate H`);
  assertEqual(aggregate.T, item.payload.eligibleBatches.reduce((sum, batch) => sum + batch.gameBatchMetrics.T, 0), `${item.name} aggregate T`);
  assertEqual(aggregate.F, item.payload.eligibleBatches.reduce((sum, batch) => sum + batch.gameBatchMetrics.F, 0), `${item.name} aggregate F`);
  assertEqual(aggregate.D, item.payload.eligibleBatches.reduce((sum, batch) => sum + batch.gameBatchMetrics.D, 0), `${item.name} aggregate D`);
  for (const batch of item.payload.eligibleBatches) {
    const projection = {...batch} as Record<string, unknown>;
    delete projection.batchPayloadSha256;
    assertEqual(batch.batchPayloadSha256, canonicalSha256(projection), `${item.name} batch hash`);
    const batchLevel = levelConfig(batch.levelBefore);
    assertEqual(batch.gameBatchMetrics.difficultyStateId, batchLevel.difficultyStateId, `${item.name} difficulty identifier`);
    assertEqual(batch.gameBatchMetrics.timingProfile, batchLevel.timingBand, `${item.name} timing identifier`);
    assertEqual(batch.gameBatchMetrics.contentVariantId, batchLevel.contentVariantId, `${item.name} content identifier`);
    assertEqual(batch.gameBatchMetrics.waveProfileId, batchLevel.waveProfileId, `${item.name} wave identifier`);
    assertEqual(batch.gameBatchMetrics.seedKey, batchLevel.seedKey, `${item.name} seed identifier`);
    assertEqual(batch.gameBatchMetrics.backgroundId, item.payload.gameMetrics.backgroundId, `${item.name} session background lock`);
  }
}
assertEqual(byName.get("L28-HOLD-0")!.payload.sessionRawScore, 0, "zero eligible score");
assertEqual(byName.get("L28-HOLD-0")!.payload.incompleteBatchAudit.length, 1, "zero eligible incomplete audit");
assertEqual(byName.get("L28-HOLD-1")!.payload.incompleteBatchAudit.length, 1, "one eligible incomplete audit");
assertEqual(byName.get("L28-HOLD-7")!.payload.incompleteBatchAudit.length, 1, "seven eligible incomplete audit");
assertEqual(byName.get("L1-HOLD-8")!.payload.incompleteBatchAudit.length, 0, "eight eligible has no incomplete audit");
assertEqual(
  byName.get("L1-FAIL-8")!.payload.eligibleBatches.map(batch => batch.levelTransition).join(","),
  "RETRY,HOLD_MIN,RETRY,HOLD_MIN,RETRY,HOLD_MIN,RETRY,HOLD_MIN",
  "L1 repeated failure alternates retry and lower-bound hold without leaving L1",
);
assert(byName.get("L1-FAIL-8")!.payload.eligibleBatches.every(batch => batch.levelBefore === 1 && batch.levelAfter === 1), "L1 lower guard preserves level one");
assertEqual(
  byName.get("L102-HOLD-8")!.payload.eligibleBatches.map(batch => batch.gameBatchMetrics.firstTeachingBatchWaveOneDoubleSuppressed).join(","),
  "true,false,false,false,false,false,false,false",
  "L102 teaching suppression is recorded only for the first formal batch",
);
for (const batch of byName.get("L120-UPGRADE-8")!.payload.eligibleBatches) {
  assertEqual(batch.resultZone, "UPGRADE", "L120 records upgrade result");
  assertEqual(batch.levelTransition, "HOLD_MAX", "L120 records upper-level hold action");
  assertEqual(batch.levelAfter, 120, "L120 levelAfter");
}
const idempotentResultSession = delayedCutoffSession();
idempotentResultSession.deadline();
const resultOne = idempotentResultSession.buildResultDraft();
const resultTwo = idempotentResultSession.buildResultDraft();
assert(isDeepFrozenJson(resultOne), "formal result draft is recursively frozen");
assertEqual(canonicalSha256(resultOne), canonicalSha256(resultTwo), "formal result draft is idempotent");

// Committed golden content must match the generator output.
const committedGolden = JSON.parse(readFileSync(resolve(process.cwd(), "../games/catch-light/golden-vectors/A620_W2_CATCH_LIGHT_golden_vectors.json"), "utf8"));
assertEqual(canonicalSha256(committedGolden), canonicalSha256(buildGoldenVectors()), "committed golden vectors are current");

// Local public-SPI adapter: strict config, atomic start, pause exclusion, late
// frames, and retry after a BATCH_CLOSED sink fails at the RUNNING-state cutoff advance.
const module = new CatchLightGameModule();
await assertRejectedAsync(() => module.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:"0".repeat(64),gameConfig:{},
}), "adapter rejects legacy empty gameConfig");
await module.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
assertEqual(module.moduleState, "READY", "adapter enters READY after prepare");
assertRejected(() => module.buildResultDraft(), "adapter cannot build a result before deadline");
assertRejected(() => module.onStart(0, 299999), "adapter rejects an inconsistent start cutoff");
assertEqual(module.moduleState, "READY", "rejected START leaves adapter READY");
module.onStart(0, 300000);
assertEqual(module.moduleState, "RUNNING", "adapter enters RUNNING after valid START");
const queryBeforeAdvance = module.snapshotAtUptime(299999);
assertEqual(queryBeforeAdvance.activeElapsedMs, 0, "QUERY_STATE does not advance logical time");
assertEqual(queryBeforeAdvance.eligibleBatchCount, 0, "QUERY_STATE does not close batches");
assertEqual(module.advanceToUptime(1000), 1000, "future QUERY_STATE metadata does not consume clock monotonicity");
assertRejected(() => module.snapshotAtUptime(-1), "QUERY_STATE rejects negative request uptime metadata");
assertRejected(() => module.snapshotAtUptime(1.5), "QUERY_STATE rejects non-integer request uptime metadata");
assertRejected(() => module.onStart(0, 300000), "adapter rejects duplicate START");
await assertRejectedAsync(() => module.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:"1".repeat(64),gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
}), "adapter rejects PREPARE while running");
module.onDeadline(300000);
assertEqual(module.moduleState, "DEADLINE", "adapter locks into DEADLINE");
assertEqual(module.buildResultDraft().eligibleBatchCount, 8, "adapter closes exactly eight batches at cutoff");
await module.dispose();
assertEqual(module.moduleState, "DISPOSED", "dispose clears module lifecycle state");

const callerOwnedConfig = jsonClone(CATCH_LIGHT_VERTICAL_SLICE_CONFIG) as unknown as Record<string, unknown>;
const detachedPrepareModule = new CatchLightGameModule();
await detachedPrepareModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,detached:true}),
  gameConfig:callerOwnedConfig,
});
(callerOwnedConfig.levels as Array<Record<string, unknown>>)[0]!.minTargetHits = 999;
detachedPrepareModule.onStart(0, 300000);
detachedPrepareModule.onDeadline(300000);
assertEqual(detachedPrepareModule.buildResultDraft().eligibleBatchCount, 8, "prepared execution is detached from caller mutation");
await detachedPrepareModule.dispose();
await detachedPrepareModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:28,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,reprepare:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
assertEqual(detachedPrepareModule.moduleState, "READY", "disposed adapter can be prepared for a new execution");
await detachedPrepareModule.dispose();

let adapterReentryError: unknown = null;
let adapterReentryState: CatchLightModuleState | null = null;
let adapterReentryModule: CatchLightGameModule;
adapterReentryModule = new CatchLightGameModule({
  onBatchClosed: () => {
    if (adapterReentryError !== null) return;
    adapterReentryError = captureRejected(
      () => adapterReentryModule.onDeadline(300000),
      "BATCH_CLOSED hook must not re-enter adapter DEADLINE",
    );
    adapterReentryState = adapterReentryModule.moduleState;
  },
});
await adapterReentryModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,adapterReentry:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
adapterReentryModule.onStart(0, 300000);
assertEqual(adapterReentryModule.advanceToUptime(37500), 37500, "adapter reaches first BATCH_CLOSED boundary");
assert(adapterReentryError !== null, "adapter rejects lifecycle re-entry from BATCH_CLOSED hook");
assertEqual(adapterReentryState, "RUNNING", "rejected callback re-entry cannot mutate adapter state");
assertEqual(adapterReentryModule.moduleState, "RUNNING", "adapter remains RUNNING after callback re-entry rejection");
assertEqual(adapterReentryModule.snapshotAtUptime(37500).eligibleBatchCount, 1, "outer batch close remains committed exactly once");
adapterReentryModule.advanceToUptime(300000);
adapterReentryModule.onDeadline(300000);
assertEqual(adapterReentryModule.buildResultDraft().eligibleBatchCount, 8, "normal deadline remains available after rejected callback re-entry");
await adapterReentryModule.dispose();

const callerGuideHistory = [102];
const introducedRuleBatches: Array<Readonly<{gameBatchMetrics:{firstTeachingBatchWaveOneDoubleSuppressed:boolean}}>> = [];
const introducedRuleModule = new CatchLightGameModule({
  previouslyIntroducedLevels: callerGuideHistory,
  onBatchClosed: batch => introducedRuleBatches.push(batch),
});
callerGuideHistory.length = 0;
await introducedRuleModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:102,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,guideHistory:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
introducedRuleModule.onStart(0, 300000);
assert(!introducedRuleModule.snapshotAtUptime(0).currentBatch!.visibleObjects.length, "L102 prompt snapshot has no visible fruit before operation");
assertEqual(introducedRuleModule.advanceToUptime(37500), 37500, "explicit frame advance, not QUERY_STATE, owns domain progression");
assertEqual(introducedRuleBatches.length, 1, "adapter closes exactly one batch at the first boundary");
assert(!introducedRuleBatches[0]!.gameBatchMetrics.firstTeachingBatchWaveOneDoubleSuppressed, "adapter detaches and forwards persisted guide history");
introducedRuleModule.onTerminate("guide-history-test-complete");
await introducedRuleModule.dispose();

const terminatedModule = new CatchLightGameModule();
await terminatedModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,terminated:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
terminatedModule.onStart(0, 300000);
terminatedModule.onTerminate("synthetic-controller-terminate");
assertEqual(terminatedModule.moduleState, "TERMINATED", "TERMINATE invalidates formal completion");
assertEqual(terminatedModule.touchInstanceAtUptime("NO_SUCH_INSTANCE", 1000).disposition, "IGNORED_WRONG_INSTANCE_PHASE", "terminated input remains locked");
terminatedModule.onDeadline(300000);
assertEqual(terminatedModule.moduleState, "TERMINATED", "post-terminate DEADLINE callback is harmless and cannot restore formal completion");
assertRejected(() => terminatedModule.buildResultDraft(), "terminated execution has no formal result draft");
await terminatedModule.dispose();

const invalidPauseModule = new CatchLightGameModule();
await invalidPauseModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,invalidPause:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
invalidPauseModule.onStart(0, 300000);
assertRejected(() => invalidPauseModule.onPause(300000), "PAUSE at the authoritative cutoff is rejected before domain progression");
assertEqual(invalidPauseModule.moduleState, "RUNNING", "rejected PAUSE leaves adapter RUNNING");
const afterRejectedPause = invalidPauseModule.snapshotAtUptime(0);
assertEqual(afterRejectedPause.activeElapsedMs, 0, "rejected PAUSE does not consume logical time");
assertEqual(afterRejectedPause.eligibleBatchCount, 0, "rejected PAUSE does not close batches");
invalidPauseModule.onDeadline(300000);
await invalidPauseModule.dispose();

const pausedModule = new CatchLightGameModule();
await pausedModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,pause:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
pausedModule.onStart(1000, 301000);
pausedModule.onPause(2000);
assertEqual(pausedModule.touchInstanceAtUptime("NO_SUCH_INSTANCE", 2500).disposition, "IGNORED_WRONG_INSTANCE_PHASE", "paused input is disabled");
assertRejected(() => pausedModule.onDeadline(301000), "adapter rejects deadline while paused");
assertRejected(() => pausedModule.onResume(6000, 304999), "adapter rejects a resume cutoff with the wrong remaining active duration");
assertEqual(pausedModule.moduleState, "PAUSED", "rejected RESUME leaves adapter PAUSED");
assertEqual(pausedModule.snapshotAtUptime(100000).activeElapsedMs, 1000, "paused QUERY_STATE does not unfreeze logical time");
pausedModule.onResume(6000, 305000);
pausedModule.onDeadline(305000);
const pausedDraft = pausedModule.buildResultDraft();
assertEqual(pausedDraft.gameMetrics.pauseCount, 1, "adapter records pause count");
assertEqual(pausedDraft.gameMetrics.totalPausedDurationMs, 4000, "adapter records pause plus resume-countdown wall duration");
await pausedModule.dispose();

const lateDeadlineModule = new CatchLightGameModule();
await lateDeadlineModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,lateFrame:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
lateDeadlineModule.onStart(0, 300000);
assertEqual(lateDeadlineModule.advanceToUptime(300001), 300000, "adapter clamps a late frame");
lateDeadlineModule.onDeadline(300000);
assertEqual(lateDeadlineModule.snapshotAtUptime(300000).activeElapsedMs, 300000, "DEADLINE snapshot remains available at the authoritative cutoff after a late frame");
assertEqual(lateDeadlineModule.buildResultDraft().actualTrainingMs, 300000, "late frame does not block formal deadline");
await lateDeadlineModule.dispose();

let pauseHookFailsOnce = true;
let pauseHookCalls = 0;
const pauseRetryModule = new CatchLightGameModule({
  onBatchClosed: () => {
    pauseHookCalls += 1;
    if (pauseHookFailsOnce) {
      pauseHookFailsOnce = false;
      throw new Error("synthetic pause-boundary sink failure");
    }
  },
});
await pauseRetryModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,pauseRetry:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
pauseRetryModule.onStart(0, 300000);
assertRejected(() => pauseRetryModule.onPause(37500), "pause-boundary evidence failure is surfaced");
assertEqual(pauseRetryModule.moduleState, "RUNNING", "failed pause leaves module and clock in retryable RUNNING state");
pauseRetryModule.retryPendingBatchNotifications();
pauseRetryModule.onPause(37500);
assertEqual(pauseRetryModule.moduleState, "PAUSED", "same pause boundary succeeds after evidence retry");
pauseRetryModule.onResume(38500, 301000);
pauseRetryModule.advanceToUptime(301000);
pauseRetryModule.onDeadline(301000);
assertEqual(pauseRetryModule.buildResultDraft().eligibleBatchCount, 8, "pause-boundary retry does not duplicate or skip a batch");
assertEqual(pauseHookCalls, 9, "pause-boundary retry produces one failed attempt and eight successful batch deliveries");
await pauseRetryModule.dispose();

let deadlineHookFailsOnce = true;
let deadlineHookCalls = 0;
const deadlineDelivered = new Set<string>();
const resilientModule = new CatchLightGameModule({
  onBatchClosed: batch => {
    deadlineHookCalls += 1;
    if (deadlineHookFailsOnce) {
      deadlineHookFailsOnce = false;
      throw new Error("synthetic deadline sink failure");
    }
    deadlineDelivered.add(batch.batchPayloadSha256);
  },
});
await resilientModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,retry:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
resilientModule.onStart(0, 300000);
assertRejected(() => resilientModule.advanceToUptime(300000), "cutoff evidence failure is surfaced while public state is RUNNING");
resilientModule.retryPendingBatchNotifications();
assertRejected(
  () => resilientModule.onDeadline(300000),
  "deadline is rejected until cutoff progression resumes after evidence retry",
);
resilientModule.advanceToUptime(300000);
resilientModule.onDeadline(300000);
const resilientDraft = resilientModule.buildResultDraft();
assertEqual(resilientDraft.eligibleBatchCount, 8, "deadline retry completes all eight batches");
assertEqual(deadlineDelivered.size, 8, "deadline retry delivers eight unique batch hashes");
assertEqual(deadlineHookCalls, 9, "one failed delivery plus eight successful deliveries");
await resilientModule.dispose();

console.log("CATCH_LIGHT_W2_TYPESCRIPT_TESTS_PASS");
