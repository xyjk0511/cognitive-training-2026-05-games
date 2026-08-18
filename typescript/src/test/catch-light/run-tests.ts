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
  FRUIT_POOLS,
  GRID_CATALOG,
  XorShift32,
  applyLevelDecision,
  batchScore,
  buildGoldenVectors,
  buildHeadlessEvidence,
  fnv1a32Utf8,
  generateBatchSchedule,
  levelConfig,
  parseStrictGameConfig,
  resultZone,
  roundHalfUpFraction,
  validateGeneratedSchedule,
  validateVerticalSliceConfig,
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

async function assertRejectedAsync(action: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  assert(rejected, message);
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

// Frozen configuration, catalog, and no-fallback rule.
validateVerticalSliceConfig(CATCH_LIGHT_VERTICAL_SLICE_CONFIG);
assertEqual(FRUIT_CATALOG.length, 12, "fruit catalog size");
assertEqual(new Set(FRUIT_CATALOG.map(fruit => fruit.fruitId)).size, 12, "fruit ids unique");
assertEqual(new Set(FRUIT_CATALOG.map(fruit => fruit.assetPath)).size, 12, "fruit asset paths unique");
assertEqual(FRUIT_POOLS.FP_CORE_A.length, 6, "CORE_A size");
assertEqual(FRUIT_POOLS.FP_CORE_B.length, 6, "CORE_B size");
assertEqual(FRUIT_POOLS.FP_TRANSFER.length, 12, "TRANSFER size");
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
const exactRuntimeConfig = JSON.parse(JSON.stringify(CATCH_LIGHT_VERTICAL_SLICE_CONFIG)) as Record<string, unknown>;
assertEqual(parseStrictGameConfig(exactRuntimeConfig).configSetId, CATCH_LIGHT_VERTICAL_SLICE_CONFIG.configSetId, "exact compiled runtime config accepted");
const workbookDrift = JSON.parse(JSON.stringify(CATCH_LIGHT_VERTICAL_SLICE_CONFIG)) as Record<string, unknown>;
workbookDrift.sourceWorkbookSha256 = "0".repeat(64);
assertRejected(() => parseStrictGameConfig(workbookDrift), "source provenance drift is rejected");
const catalogDrift = JSON.parse(JSON.stringify(CATCH_LIGHT_VERTICAL_SLICE_CONFIG)) as {fruitCatalog:Array<Record<string, unknown>>};
catalogDrift.fruitCatalog[0]!.textureCue = "DRIFT";
assertRejected(() => parseStrictGameConfig(catalogDrift as unknown as Record<string, unknown>), "fruit catalog drift is rejected");
const thresholdDrift = JSON.parse(JSON.stringify(CATCH_LIGHT_VERTICAL_SLICE_CONFIG)) as {levels:Array<Record<string, unknown>>};
thresholdDrift.levels[0]!.minTargetHits = 9;
assertRejected(() => parseStrictGameConfig(thresholdDrift as unknown as Record<string, unknown>), "cross-field threshold drift is rejected");
assertRejected(() => new CatchLightSession({
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
  runtimeConfigHash:CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256,
  sessionSeed:CATCH_LIGHT_QA_SEED,
  sessionStartLevel:67,
}), "L67 is a golden-only anchor, not a released W2 runtime slice");

// FNV-1a32 -> xorshift32 -> Fisher-Yates deterministic chain.
assertEqual(fnv1a32Utf8(""), 0x811c9dc5, "FNV empty vector");
assertEqual(fnv1a32Utf8("hello"), 0x4f9f2cab, "FNV ASCII vector");
assertEqual(fnv1a32Utf8("捕光行动"), 0xa9ed4b3e, "FNV UTF-8 vector");
const xs = new XorShift32(1);
assertEqual([xs.nextUint32(), xs.nextUint32(), xs.nextUint32()].join(","), "270369,67634689,2647435461", "xorshift32 vector");
const zeroSeed = new XorShift32(0);
assertEqual(zeroSeed.nextUint32(), 1085196063, "zero-state replacement vector");

const expectedScheduleHashes = new Map<number, string>([
  [1, "8f7e72cefab31042939ebc8b3e8ce40c524250d8a8b1c98e65a1c67dadff1646"],
  [28, "1c87f3d21d05905bea1c9390194f9cce3eca55d99dcadaa8bb3148135211edf7"],
  [67, "89b292798229a09ce332913c9da89c777b31fe6a40dac555f46be1fd49cf1818"],
  [102, "c9e8280168c7e543e14fed2e2df6fbb917ed2ed5540a436406657ddde94ccdc5"],
  [120, "61355f2d324384aa1c3234c202a21384f8ccc592c65fd31a951906a4c999a2fd"],
]);
for (const [level, expectedHash] of expectedScheduleHashes) {
  const a = generateBatchSchedule(level, CATCH_LIGHT_QA_SEED, 1);
  const b = generateBatchSchedule(level, CATCH_LIGHT_QA_SEED, 1);
  validateGeneratedSchedule(a);
  assertEqual(canonicalSha256(a), canonicalSha256(b), `L${level} deterministic schedule`);
  assertEqual(a.scheduleSha256, expectedHash, `L${level} golden schedule hash`);
  assert(a.scheduleSha256 !== generateBatchSchedule(level, CATCH_LIGHT_QA_SEED, 2).scheduleSha256, `L${level} batch ordinal changes schedule`);
  assert(a.waves.every(wave => wave.instances.length <= a.sameScreenCap), `L${level} same-screen cap`);
  assert(a.waves.every(wave => wave.instances.filter(instance => instance.role === "DISTRACTOR").every((instance, index, list) => list.findIndex(other => other.fruitId === instance.fruitId) === index)), `L${level} distractor uniqueness per wave`);
}
const l102 = generateBatchSchedule(102, CATCH_LIGHT_QA_SEED, 1);
const l102DoubleWaves = l102.waves.filter(wave => wave.instances.some(instance => instance.isDouble)).map(wave => wave.waveOrdinal);
assertEqual(l102DoubleWaves.length, 2, "L102 double count");
assert(!l102DoubleWaves.includes(1), "L102 teaching wave one excludes double target");
assert(Math.abs(l102DoubleWaves[0]! - l102DoubleWaves[1]!) > 1, "L102 double waves are separated");
const l120 = generateBatchSchedule(120, CATCH_LIGHT_QA_SEED, 1);
assertEqual(l120.waves.flatMap(wave => wave.instances).filter(instance => instance.isDouble).length, 6, "L120 six doubles");
assertEqual(Math.max(...l120.waves.map(wave => wave.instances.length)), 5, "L120 hard same-screen cap");
let l120Run = 0;
let l120MaxRun = 0;
for (const wave of l120.waves) {
  if (wave.instances.some(instance => instance.isDouble)) { l120Run += 1; l120MaxRun = Math.max(l120MaxRun, l120Run); }
  else l120Run = 0;
}
assert(l120MaxRun <= 3, "L120 MAX3_CONSEC");

// Half-open object windows and duplicate/multi-touch suppression.
assertEqual(new FruitObjectRuntime(objectInstance()).touch(99).disposition, "IGNORED_BEFORE_WINDOW", "touch before active window");
assertEqual(new FruitObjectRuntime(objectInstance()).touch(100).disposition, "TARGET_HIT", "touch at active start");
assertEqual(new FruitObjectRuntime(objectInstance()).touch(999).disposition, "TARGET_HIT", "touch one ms before deadline");
assertEqual(new FruitObjectRuntime(objectInstance()).touch(1000).disposition, "IGNORED_AT_OR_AFTER_DEADLINE", "touch at exact deadline");
const repeated = new FruitObjectRuntime(objectInstance());
assertEqual(repeated.touch(100).hitDelta, 1, "first target touch increments H");
assertEqual(repeated.touch(100).disposition, "IGNORED_SAME_TIMESTAMP", "same-object simultaneous second finger ignored");
assertEqual(repeated.touch(101).disposition, "IGNORED_ALREADY_SETTLED", "repeat after settlement ignored");

const double = new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1200,activeStartMs:0,activeDeadlineMs:5000,enterEndMs:200,exitStartMs:4800}));
assertEqual(double.touch(1000).disposition, "DOUBLE_FIRST", "double first touch");
assertEqual(double.touch(1000).disposition, "IGNORED_SAME_TIMESTAMP", "double same-timestamp second finger ignored");
assertEqual(double.touch(1001).disposition, "DOUBLE_COMPLETED", "double second sequential touch");
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

// Pause and the external three-second resume countdown do not consume active time or the double window.
const pausedClock = new ActiveLogicalClock();
pausedClock.start(1000, 303900);
const pausedDouble = new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1200,activeStartMs:0,activeDeadlineMs:5000,enterEndMs:200,exitStartMs:4800}));
assertEqual(pausedDouble.touch(pausedClock.activeElapsedAt(2000)).disposition, "DOUBLE_FIRST", "double first before pause");
assertEqual(pausedClock.pause(2100), 1100, "pause freezes accumulated active time");
pausedClock.resume(5000, 303900);
assertEqual(pausedDouble.touch(pausedClock.activeElapsedAt(6099)).disposition, "DOUBLE_COMPLETED", "double completes after pause with frozen window");
const exactClock = new ActiveLogicalClock();
exactClock.start(1000, 303900);
const exactDouble = new FruitObjectRuntime(objectInstance({isDouble:true,doubleWindowMs:1200,activeStartMs:0,activeDeadlineMs:5000,enterEndMs:200,exitStartMs:4800}));
exactDouble.touch(exactClock.activeElapsedAt(2000));
exactClock.pause(2100);
exactClock.resume(5000, 303900);
assertEqual(exactDouble.touch(exactClock.activeElapsedAt(6100)).disposition, "IGNORED_AT_OR_AFTER_DEADLINE", "pause-adjusted exact second deadline invalid");

// Different objects at the same millisecond are independently valid; blank touches never add F.
const l28Config = levelConfig(28);
const l28Schedule = generateBatchSchedule(l28Config, CATCH_LIGHT_QA_SEED, 1);
const l28Batch = new CatchLightBatchRuntime({batchOrdinal:1,batchStartActiveMs:0,levelBefore:28,consecutiveFailBefore:0,levelConfig:l28Config,schedule:l28Schedule});
const firstWaveTarget = l28Schedule.waves[0]!.instances.find(instance => instance.role === "TARGET")!;
const firstWaveDistractor = l28Schedule.waves[0]!.instances.find(instance => instance.role === "DISTRACTOR")!;
const sameMs = l28Batch.operationStartActiveMs + firstWaveTarget.activeStartMs;
l28Batch.touchBlank(l28Batch.operationStartActiveMs + 100);
assertEqual(l28Batch.falseTouchCount, 0, "blank touch does not add F");
assertEqual(l28Batch.touchInstance(firstWaveTarget.instanceId, sameMs).disposition, "TARGET_HIT", "same-ms target valid");
assertEqual(l28Batch.touchInstance(firstWaveDistractor.instanceId, sameMs).disposition, "DISTRACTOR_FALSE_TOUCH", "different object same-ms distractor valid");
assertEqual(l28Batch.hitCount, 1, "same-ms H count");
assertEqual(l28Batch.falseTouchCount, 1, "same-ms F count");
assertEqual(l28Batch.touchInstance(firstWaveDistractor.instanceId, sameMs).disposition, "IGNORED_SAME_TIMESTAMP", "distractor duplicate suppressed");
assertEqual(l28Batch.falseTouchCount, 1, "distractor only counts once");

// Partial audit counts only targets that have actually reached their presentation window.
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

// The session deadline is a half-open input boundary even when a delayed batch is still active.
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
const beforeCutoffBatch = beforeCutoffSession.currentBatchRuntime!;
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

// A late observed frame must not invalidate the controller-owned cutoff callback.
const lateFrameClock = new ActiveLogicalClock();
lateFrameClock.start(1000, 301000);
assertEqual(lateFrameClock.activeElapsedAt(301001), 300000, "late frame clamps to active deadline");
assertEqual(lateFrameClock.deadline(301000), 300000, "authoritative deadline survives a previously observed late frame");

// Integer-only decision boundaries, D=0 no divide-by-zero, and RoundHalfUp.
assertEqual(roundHalfUpFraction(1, 2), 1, "RoundHalfUp exact half");
assertEqual(roundHalfUpFraction(1, 3), 0, "RoundHalfUp below half");
assertEqual(roundHalfUpFraction(2, 3), 1, "RoundHalfUp above half");
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

assertEqual(applyLevelDecision(10,"UPGRADE",1).levelTransition, "UP", "upgrade clears fail and advances");
assertEqual(applyLevelDecision(120,"UPGRADE",0).levelTransition, "HOLD_MAX", "L120 upper guard");
assertEqual(applyLevelDecision(10,"HOLD",1).consecutiveFailAfter, 0, "hold clears fail streak");
assertEqual(applyLevelDecision(10,"FAIL",0).levelTransition, "RETRY", "first fail retries");
assertEqual(applyLevelDecision(10,"FAIL",1).levelTransition, "DOWN", "second fail descends");
assertEqual(applyLevelDecision(1,"FAIL",1).levelTransition, "HOLD_MIN", "L1 lower guard");

// Complete headless vertical slices and 0/1/7/8 eligible-batch cutoffs.
const evidence = buildHeadlessEvidence();
const byName = new Map(evidence.map(item => [item.name, item]));
for (const name of ["L1-HOLD-8","L28-HOLD-8","L102-HOLD-8","L120-UPGRADE-8","L28-HOLD-0","L28-HOLD-1","L28-HOLD-7"]) {
  assert(byName.has(name), `missing headless evidence ${name}`);
}
for (const item of evidence) {
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
for (const batch of byName.get("L120-UPGRADE-8")!.payload.eligibleBatches) {
  assertEqual(batch.resultZone, "UPGRADE", "L120 records upgrade result");
  assertEqual(batch.levelTransition, "HOLD_MAX", "L120 records upper-level hold action");
  assertEqual(batch.levelAfter, 120, "L120 levelAfter");
}

// Committed golden file must be byte-equivalent in canonical content to the generator output.
const committedGolden = JSON.parse(readFileSync(resolve(process.cwd(), "../games/catch-light/golden-vectors/A620_W2_CATCH_LIGHT_golden_vectors.json"), "utf8"));
assertEqual(canonicalSha256(committedGolden), canonicalSha256(buildGoldenVectors()), "committed golden vectors are current");

// The local adapter uses the frozen public SPI without editing it, while rejecting legacy empty runtime config.
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
module.onStart(0, 300000);
module.onDeadline(300000);
assertEqual(module.buildResultDraft().eligibleBatchCount, 8, "adapter closes exactly eight batches at cutoff");
await module.dispose();

const pausedModule = new CatchLightGameModule();
await pausedModule.prepare({
  gameCode:"CATCH_LIGHT",sessionSeed:CATCH_LIGHT_QA_SEED,sessionStartLevel:1,durationMs:300000,
  runtimeConfigHash:canonicalSha256({schemaId:CATCH_LIGHT_CONFIG_SCHEMA_ID,config:CATCH_LIGHT_VERTICAL_SLICE_CONFIG,pause:true}),
  gameConfig:CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
});
pausedModule.onStart(1000, 301000);
pausedModule.onPause(2000);
assertEqual(pausedModule.touchInstanceAtUptime("NO_SUCH_INSTANCE", 2500).disposition, "IGNORED_WRONG_INSTANCE_PHASE", "paused input is disabled");
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
assertEqual(lateDeadlineModule.buildResultDraft().actualTrainingMs, 300000, "late frame does not block formal deadline");
await lateDeadlineModule.dispose();

console.log("CATCH_LIGHT_W2_TYPESCRIPT_TESTS_PASS");
