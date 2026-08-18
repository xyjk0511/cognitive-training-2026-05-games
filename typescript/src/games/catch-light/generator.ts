import { canonicalSha256 } from "../../canonical.js";
import { FRUIT_POOLS, fruitDefinition, fruitsAreSimilar, gridDefinition } from "./assets.js";
import { levelConfig, validateLevelConfig, waveProfile } from "./config.js";
import { immutableSnapshot, isDeepFrozenJson } from "./immutability.js";
import { prngFor, type XorShift32 } from "./prng.js";
import {
  CATCH_LIGHT_CONFIG_SET_ID,
  CATCH_LIGHT_GENERATOR_VERSION,
  PLANNED_BATCH_COUNT,
  WAVE_COUNT,
  type CatchLightLevelConfig,
  type FruitId,
  type GeneratedBatchSchedule,
  type GeneratedInstance,
  type GeneratedWave,
  type GridSlot,
} from "./types.js";

function rotated(values: readonly number[], amount: number): number[] {
  return values.map((_, index) => values[(index + amount) % values.length]!);
}

function quotaFlags(total: number, quota: number, prng: XorShift32): boolean[] {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(quota) || quota < 0 || quota > total) {
    throw new Error(`invalid quota ${quota}/${total}`);
  }
  const selected = new Set(prng.shuffle(Array.from({length: total}, (_, index) => index)).slice(0, quota));
  return Array.from({length: total}, (_, index) => selected.has(index));
}

/**
 * Similar distractors are spread across distinct coexistence waves. This is
 * stricter than a blind global shuffle and guarantees that targets with only
 * one approved single-attribute neighbour (for example BANANA or GRAPE) remain
 * generatable for every seed without duplicating a distractor within a wave.
 */
function similarFlagsByWave(distractorsByWave: readonly number[], quota: number, prng: XorShift32): boolean[][] {
  if (!Number.isSafeInteger(quota) || quota < 0) throw new Error("similar distractor quota must be a non-negative safe integer");
  const eligibleWaves = distractorsByWave
    .map((count, index) => ({count, index}))
    .filter(item => item.count > 0);
  if (quota > eligibleWaves.length) {
    throw new Error(`similar distractor quota ${quota} exceeds ${eligibleWaves.length} coexistence waves`);
  }
  const selectedWaves = new Set(prng.shuffle(eligibleWaves.map(item => item.index)).slice(0, quota));
  return distractorsByWave.map((count, waveIndex) => {
    const flags = new Array<boolean>(count).fill(false);
    if (selectedWaves.has(waveIndex)) flags[prng.nextIndex(count)] = true;
    return flags;
  });
}

function maximumConsecutive(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let best = 1;
  let current = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]! + 1) current += 1;
    else current = 1;
    best = Math.max(best, current);
  }
  return best;
}

function enumerateWaveSelections(count: number, suppressWaveOne: boolean, maxConsecutive: number): number[][] {
  const candidates = Array.from({length: WAVE_COUNT}, (_, index) => index + 1)
    .filter(waveOrdinal => !suppressWaveOne || waveOrdinal !== 1);
  const selections: number[][] = [];
  const visit = (startIndex: number, selected: number[]): void => {
    if (selected.length === count) {
      if (maximumConsecutive(selected) <= maxConsecutive) selections.push([...selected]);
      return;
    }
    const remainingNeeded = count - selected.length;
    for (let index = startIndex; index <= candidates.length - remainingNeeded; index += 1) {
      selected.push(candidates[index]!);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return selections;
}

function chooseDoubleWaves(config: CatchLightLevelConfig, prng: XorShift32, suppressWaveOne: boolean): Set<number> {
  if (config.doubleTargetCount === 0) return new Set<number>();
  if (config.doublePatternId === "NONE") throw new Error(`${config.seedKey}: double target count requires a consecutive-wave pattern`);
  const maxConsecutive = config.doublePatternId === "MAX3_CONSEC" ? 3 : 2;
  const candidates = enumerateWaveSelections(config.doubleTargetCount, suppressWaveOne, maxConsecutive);
  if (candidates.length === 0) throw new Error(`${config.seedKey}: no legal double-target wave allocation`);
  return new Set(prng.shuffle(candidates)[0]!);
}

interface InstancePlan {
  role: "TARGET" | "DISTRACTOR";
  fruitId: FruitId;
  similarityClass: "TARGET" | "SIMILAR" | "CLEAR";
  edgeEmphasis: boolean;
  isDouble: boolean;
  ordinalInRole: number;
}

function chooseDistractor(
  targetFruitId: FruitId,
  pool: readonly FruitId[],
  similar: boolean,
  usedInWave: ReadonlySet<FruitId>,
  prng: XorShift32,
): FruitId {
  const candidates = pool.filter(candidate =>
    candidate !== targetFruitId
    && fruitDefinition(candidate).distractorAllowed
    && !usedInWave.has(candidate)
    && fruitsAreSimilar(targetFruitId, candidate) === similar,
  );
  if (candidates.length === 0) {
    throw new Error(`fruit pool cannot satisfy ${similar ? "similar" : "clear"} distractor uniqueness for target ${targetFruitId}`);
  }
  return prng.shuffle(candidates)[0]!;
}

function assignSlots(
  plans: readonly InstancePlan[],
  gridSlots: readonly GridSlot[],
  previousPrimaryTargetSlot: string | null,
  prng: XorShift32,
): Map<number, GridSlot> {
  if (plans.length > gridSlots.length) throw new Error("wave has more instances than grid slots");
  const available = new Map(gridSlots.map(slot => [slot.slotId, slot]));
  const assignments = new Map<number, GridSlot>();
  const indices = plans.map((_, index) => index);
  const allocationOrder = [
    ...indices.filter(index => plans[index]!.edgeEmphasis),
    ...indices.filter(index => !plans[index]!.edgeEmphasis),
  ];

  for (const index of allocationOrder) {
    const plan = plans[index]!;
    let candidates = [...available.values()].filter(slot => !plan.edgeEmphasis || slot.edgeSlot);
    if (candidates.length === 0) throw new Error("edge-emphasis quota cannot be placed in selected grid");
    if (index === 0 && previousPrimaryTargetSlot !== null) {
      const alternatives = candidates.filter(slot => slot.slotId !== previousPrimaryTargetSlot);
      if (alternatives.length === 0) throw new Error("primary target slot cannot change between adjacent waves");
      candidates = alternatives;
    }
    const slot = prng.shuffle(candidates)[0]!;
    assignments.set(index, slot);
    available.delete(slot.slotId);
  }
  return assignments;
}

export interface BatchGenerationOptions {
  /** Session-locked background selected once by the integration layer. */
  backgroundIdOverride?: string;
  /** Explicit level-entry fact. Defaults to batch 1 only for standalone/golden generation. */
  firstFormalTeachingBatch?: boolean;
}

function waveOneSuppressionFor(
  config: CatchLightLevelConfig,
  batchOrdinal: number,
  options: BatchGenerationOptions,
): boolean {
  if (options.firstFormalTeachingBatch !== undefined && typeof options.firstFormalTeachingBatch !== "boolean") {
    throw new Error("firstFormalTeachingBatch must be boolean when supplied");
  }
  const firstFormalTeachingBatch = options.firstFormalTeachingBatch ?? batchOrdinal === 1;
  return config.firstTeachingBatchWaveOneDoubleDisabled && firstFormalTeachingBatch;
}

function buildBatchScheduleUnchecked(
  levelOrConfig: number | CatchLightLevelConfig,
  sessionSeed: number,
  batchOrdinal: number,
  options: BatchGenerationOptions = {},
): GeneratedBatchSchedule {
  const config = typeof levelOrConfig === "number" ? levelConfig(levelOrConfig) : immutableSnapshot(levelOrConfig);
  validateLevelConfig(config);
  if (!Number.isSafeInteger(sessionSeed) || sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
  if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 1 || batchOrdinal > PLANNED_BATCH_COUNT) {
    throw new Error(`batchOrdinal must be in 1..${PLANNED_BATCH_COUNT}`);
  }
  const backgroundId = options.backgroundIdOverride ?? config.backgroundId;
  if (!/^BG0[1-8]$/.test(backgroundId)) throw new Error(`invalid session backgroundId: ${backgroundId}`);

  const profile = waveProfile(config.waveProfileId);
  const targetsByWave = rotated(profile.targetsByWave, config.waveRotation);
  const distractorsByWave = rotated(profile.distractorsByWave, config.waveRotation);
  const batchPlan = prngFor(config.seedKey, sessionSeed, batchOrdinal, 0);
  const waveOneDoubleSuppressed = waveOneSuppressionFor(config, batchOrdinal, options);
  const pool = FRUIT_POOLS[config.fruitPoolId];
  const targetCandidates = pool.filter(fruitId => fruitDefinition(fruitId).targetAllowed);
  if (targetCandidates.length === 0) throw new Error(`${config.fruitPoolId}: no target-eligible fruit`);
  const targetFruitId = batchPlan.prng.shuffle(targetCandidates)[0]!;
  if (config.similarDistractorCount > 0 && !pool.some(candidate => fruitsAreSimilar(targetFruitId, candidate))) {
    throw new Error(`${config.seedKey}: selected target ${targetFruitId} has no declared similar distractor`);
  }
  const similarFlags = similarFlagsByWave(distractorsByWave, config.similarDistractorCount, batchPlan.prng);
  const targetEdgeFlags = quotaFlags(config.targetTotal, config.targetFarEdgeCount, batchPlan.prng);
  const distractorEdgeFlags = quotaFlags(config.distractorTotal, config.distractorFarEdgeCount, batchPlan.prng);
  const doubleWaves = chooseDoubleWaves(config, batchPlan.prng, waveOneDoubleSuppressed);
  const grid = gridDefinition(config.gridId);
  const waves: GeneratedWave[] = [];
  let targetGlobalOrdinal = 0;
  let distractorGlobalOrdinal = 0;
  let previousPrimaryTargetSlot: string | null = null;

  for (let waveIndex = 0; waveIndex < WAVE_COUNT; waveIndex += 1) {
    const waveOrdinal = waveIndex + 1;
    const targetCount = targetsByWave[waveIndex]!;
    const distractorCount = distractorsByWave[waveIndex]!;
    if (targetCount + distractorCount > config.sameScreenCap) {
      throw new Error(`${config.seedKey}: generated wave ${waveOrdinal} exceeds sameScreenCap`);
    }
    const waveRandom = prngFor(config.seedKey, sessionSeed, batchOrdinal, waveOrdinal);
    const doubleTargetIndex = doubleWaves.has(waveOrdinal) ? waveRandom.prng.nextIndex(targetCount) : -1;
    const plans: InstancePlan[] = [];

    for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
      plans.push({
        role: "TARGET",
        fruitId: targetFruitId,
        similarityClass: "TARGET",
        edgeEmphasis: targetEdgeFlags[targetGlobalOrdinal]!,
        isDouble: targetIndex === doubleTargetIndex,
        ordinalInRole: targetIndex + 1,
      });
      targetGlobalOrdinal += 1;
    }

    const usedDistractors = new Set<FruitId>();
    for (let distractorIndex = 0; distractorIndex < distractorCount; distractorIndex += 1) {
      const similar = similarFlags[waveIndex]![distractorIndex]!;
      const fruitId = chooseDistractor(targetFruitId, pool, similar, usedDistractors, waveRandom.prng);
      usedDistractors.add(fruitId);
      plans.push({
        role: "DISTRACTOR",
        fruitId,
        similarityClass: similar ? "SIMILAR" : "CLEAR",
        edgeEmphasis: distractorEdgeFlags[distractorGlobalOrdinal]!,
        isDouble: false,
        ordinalInRole: distractorIndex + 1,
      });
      distractorGlobalOrdinal += 1;
    }

    const slots = assignSlots(plans, grid.slots, previousPrimaryTargetSlot, waveRandom.prng);
    const onsetMs = config.firstWaveMs + waveIndex * config.waveSpacingMs;
    const instances: GeneratedInstance[] = plans.map((plan, planIndex) => {
      const roleCode = plan.role === "TARGET" ? "T" : "D";
      const slot = slots.get(planIndex);
      if (slot === undefined) throw new Error("internal slot assignment failure");
      return {
        instanceId: `B${String(batchOrdinal).padStart(2, "0")}-W${String(waveOrdinal).padStart(2, "0")}-${roleCode}${String(plan.ordinalInRole).padStart(2, "0")}`,
        waveOrdinal,
        ordinalInWave: planIndex + 1,
        role: plan.role,
        fruitId: plan.fruitId,
        similarityClass: plan.similarityClass,
        slotId: slot.slotId,
        edgeEmphasis: plan.edgeEmphasis,
        isDouble: plan.isDouble,
        activeStartMs: onsetMs,
        activeDeadlineMs: onsetMs + config.stimulusLifecycleMs,
        enterEndMs: onsetMs + config.enterAnimationMs,
        exitStartMs: onsetMs + config.stimulusLifecycleMs - config.exitAnimationMs,
        doubleWindowMs: plan.isDouble ? config.doubleWindowMs : 0,
      };
    });
    previousPrimaryTargetSlot = instances[0]!.slotId;
    waves.push({
      waveOrdinal,
      seedMaterial: waveRandom.material,
      seed32: waveRandom.seed32,
      onsetMs,
      targetCount,
      distractorCount,
      instances,
    });
  }

  const projection: Omit<GeneratedBatchSchedule, "scheduleSha256"> = {
    generatorVersion: CATCH_LIGHT_GENERATOR_VERSION,
    configSetId: CATCH_LIGHT_CONFIG_SET_ID,
    level: config.level,
    batchOrdinal,
    sessionSeed,
    seedKey: config.seedKey,
    batchPlanSeedMaterial: batchPlan.material,
    batchPlanSeed32: batchPlan.seed32,
    targetFruitId,
    backgroundId,
    gridId: config.gridId,
    targetTotal: config.targetTotal,
    distractorTotal: config.distractorTotal,
    sameScreenCap: config.sameScreenCap,
    firstTeachingBatchWaveOneDoubleSuppressed: waveOneDoubleSuppressed,
    waves,
  };
  const schedule: GeneratedBatchSchedule = {...projection, scheduleSha256: canonicalSha256(projection)};
  return schedule;
}

export function generateBatchSchedule(
  levelOrConfig: number | CatchLightLevelConfig,
  sessionSeed: number,
  batchOrdinal: number,
  options: BatchGenerationOptions = {},
): GeneratedBatchSchedule {
  const config = typeof levelOrConfig === "number" ? levelConfig(levelOrConfig) : immutableSnapshot(levelOrConfig);
  const schedule = buildBatchScheduleUnchecked(config, sessionSeed, batchOrdinal, options);
  validateGeneratedSchedule(schedule, config);
  const frozen = immutableSnapshot(schedule);
  if (!isDeepFrozenJson(frozen)) throw new Error("generated schedule was not deeply frozen");
  return frozen;
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

export function validateGeneratedSchedule(
  schedule: GeneratedBatchSchedule,
  config: CatchLightLevelConfig = levelConfig(schedule.level),
): void {
  validateLevelConfig(config);
  if (!Number.isSafeInteger(schedule.sessionSeed) || schedule.sessionSeed < 0) throw new Error("schedule sessionSeed is invalid");
  if (!Number.isSafeInteger(schedule.batchOrdinal) || schedule.batchOrdinal < 1 || schedule.batchOrdinal > PLANNED_BATCH_COUNT) {
    throw new Error("schedule batchOrdinal is invalid");
  }
  assertEqual(schedule.generatorVersion, CATCH_LIGHT_GENERATOR_VERSION, "generatorVersion");
  assertEqual(schedule.configSetId, CATCH_LIGHT_CONFIG_SET_ID, "configSetId");
  assertEqual(schedule.level, config.level, "level");
  assertEqual(schedule.seedKey, config.seedKey, "seedKey");
  assertEqual(schedule.gridId, config.gridId, "gridId");
  assertEqual(schedule.targetTotal, config.targetTotal, "targetTotal");
  assertEqual(schedule.distractorTotal, config.distractorTotal, "distractorTotal");
  assertEqual(schedule.sameScreenCap, config.sameScreenCap, "sameScreenCap");
  if (!/^BG0[1-8]$/.test(schedule.backgroundId)) throw new Error("backgroundId is invalid");
  if (typeof schedule.firstTeachingBatchWaveOneDoubleSuppressed !== "boolean") {
    throw new Error("firstTeachingBatchWaveOneDoubleSuppressed must be boolean");
  }
  if (schedule.firstTeachingBatchWaveOneDoubleSuppressed && !config.firstTeachingBatchWaveOneDoubleDisabled) {
    throw new Error("wave-one suppression is not legal for this level");
  }

  const batchSeed = prngFor(config.seedKey, schedule.sessionSeed, schedule.batchOrdinal, 0);
  assertEqual(schedule.batchPlanSeedMaterial, batchSeed.material, "batchPlanSeedMaterial");
  assertEqual(schedule.batchPlanSeed32, batchSeed.seed32, "batchPlanSeed32");

  const pool = FRUIT_POOLS[config.fruitPoolId];
  if (!pool.includes(schedule.targetFruitId) || !fruitDefinition(schedule.targetFruitId).targetAllowed) {
    throw new Error("target fruit is outside the configured target-eligible pool");
  }
  if (schedule.waves.length !== WAVE_COUNT) throw new Error("generated schedule must have eight waves");
  const profile = waveProfile(config.waveProfileId);
  const expectedTargetsByWave = rotated(profile.targetsByWave, config.waveRotation);
  const expectedDistractorsByWave = rotated(profile.distractorsByWave, config.waveRotation);
  const grid = gridDefinition(config.gridId);
  const slotById = new Map(grid.slots.map(slot => [slot.slotId, slot]));
  const allInstances: GeneratedInstance[] = [];
  let previousPrimaryTargetSlot: string | null = null;

  for (let waveIndex = 0; waveIndex < WAVE_COUNT; waveIndex += 1) {
    const wave = schedule.waves[waveIndex]!;
    const waveOrdinal = waveIndex + 1;
    const expectedTargetCount = expectedTargetsByWave[waveIndex]!;
    const expectedDistractorCount = expectedDistractorsByWave[waveIndex]!;
    const expectedSeed = prngFor(config.seedKey, schedule.sessionSeed, schedule.batchOrdinal, waveOrdinal);
    const expectedOnset = config.firstWaveMs + waveIndex * config.waveSpacingMs;
    assertEqual(wave.waveOrdinal, waveOrdinal, `wave ${waveOrdinal} ordinal`);
    assertEqual(wave.seedMaterial, expectedSeed.material, `wave ${waveOrdinal} seedMaterial`);
    assertEqual(wave.seed32, expectedSeed.seed32, `wave ${waveOrdinal} seed32`);
    assertEqual(wave.onsetMs, expectedOnset, `wave ${waveOrdinal} onsetMs`);
    assertEqual(wave.targetCount, expectedTargetCount, `wave ${waveOrdinal} targetCount`);
    assertEqual(wave.distractorCount, expectedDistractorCount, `wave ${waveOrdinal} distractorCount`);
    assertEqual(wave.instances.length, expectedTargetCount + expectedDistractorCount, `wave ${waveOrdinal} instance count`);
    if (wave.instances.length > config.sameScreenCap) throw new Error(`wave ${waveOrdinal} exceeds sameScreenCap`);
    if (new Set(wave.instances.map(instance => instance.slotId)).size !== wave.instances.length) {
      throw new Error(`wave ${waveOrdinal} has a slot collision`);
    }

    const distractorFruitIds = new Set<FruitId>();
    let doubleCount = 0;
    let similarCount = 0;
    for (let instanceIndex = 0; instanceIndex < wave.instances.length; instanceIndex += 1) {
      const instance = wave.instances[instanceIndex]!;
      const target = instanceIndex < expectedTargetCount;
      const ordinalInRole = target ? instanceIndex + 1 : instanceIndex - expectedTargetCount + 1;
      const roleCode = target ? "T" : "D";
      const expectedId = `B${String(schedule.batchOrdinal).padStart(2, "0")}-W${String(waveOrdinal).padStart(2, "0")}-${roleCode}${String(ordinalInRole).padStart(2, "0")}`;
      assertEqual(instance.instanceId, expectedId, `${expectedId} instanceId`);
      assertEqual(instance.waveOrdinal, waveOrdinal, `${expectedId} waveOrdinal`);
      assertEqual(instance.ordinalInWave, instanceIndex + 1, `${expectedId} ordinalInWave`);
      assertEqual(instance.role, target ? "TARGET" : "DISTRACTOR", `${expectedId} role`);
      assertEqual(instance.activeStartMs, expectedOnset, `${expectedId} activeStartMs`);
      assertEqual(instance.activeDeadlineMs, expectedOnset + config.stimulusLifecycleMs, `${expectedId} activeDeadlineMs`);
      assertEqual(instance.enterEndMs, expectedOnset + config.enterAnimationMs, `${expectedId} enterEndMs`);
      assertEqual(instance.exitStartMs, expectedOnset + config.stimulusLifecycleMs - config.exitAnimationMs, `${expectedId} exitStartMs`);
      const slot = slotById.get(instance.slotId);
      if (slot === undefined) throw new Error(`${expectedId} references unknown slot ${instance.slotId}`);
      if (instance.edgeEmphasis && !slot.edgeSlot) throw new Error(`${expectedId} edge emphasis is not placed on an edge slot`);

      if (target) {
        assertEqual(instance.fruitId, schedule.targetFruitId, `${expectedId} target fruit`);
        assertEqual(instance.similarityClass, "TARGET", `${expectedId} similarityClass`);
        assertEqual(instance.doubleWindowMs, instance.isDouble ? config.doubleWindowMs : 0, `${expectedId} doubleWindowMs`);
        if (instance.isDouble) doubleCount += 1;
      } else {
        if (!pool.includes(instance.fruitId) || !fruitDefinition(instance.fruitId).distractorAllowed) {
          throw new Error(`${expectedId} distractor is outside the configured distractor-eligible pool`);
        }
        if (instance.fruitId === schedule.targetFruitId) throw new Error(`${expectedId} reuses target fruit as distractor`);
        if (distractorFruitIds.has(instance.fruitId)) throw new Error(`${expectedId} duplicates a distractor fruit within the wave`);
        distractorFruitIds.add(instance.fruitId);
        const expectedSimilarity = fruitsAreSimilar(schedule.targetFruitId, instance.fruitId) ? "SIMILAR" : "CLEAR";
        assertEqual(instance.similarityClass, expectedSimilarity, `${expectedId} similarityClass`);
        if (instance.similarityClass === "SIMILAR") similarCount += 1;
        if (instance.isDouble || instance.doubleWindowMs !== 0) throw new Error(`${expectedId} distractor cannot be double`);
      }
      allInstances.push(instance);
    }
    if (doubleCount > 1) throw new Error(`wave ${waveOrdinal} has more than one double target`);
    if (similarCount > 1) throw new Error(`wave ${waveOrdinal} has more than one similar distractor`);
    const primaryTargetSlot = wave.instances[0]!.slotId;
    if (previousPrimaryTargetSlot === primaryTargetSlot) throw new Error("primary target slot repeated in adjacent waves");
    previousPrimaryTargetSlot = primaryTargetSlot;
  }

  if (new Set(allInstances.map(instance => instance.instanceId)).size !== allInstances.length) throw new Error("duplicate instanceId");
  const targets = allInstances.filter(instance => instance.role === "TARGET");
  const distractors = allInstances.filter(instance => instance.role === "DISTRACTOR");
  assertEqual(targets.length, config.targetTotal, "generated target total");
  assertEqual(distractors.length, config.distractorTotal, "generated distractor total");
  assertEqual(distractors.filter(instance => instance.similarityClass === "SIMILAR").length, config.similarDistractorCount, "similar distractor quota");
  assertEqual(targets.filter(instance => instance.edgeEmphasis).length, config.targetFarEdgeCount, "target edge-emphasis quota");
  assertEqual(distractors.filter(instance => instance.edgeEmphasis).length, config.distractorFarEdgeCount, "distractor edge-emphasis quota");
  assertEqual(targets.filter(instance => instance.isDouble).length, config.doubleTargetCount, "double-target quota");

  const doubleWaves = schedule.waves
    .filter(wave => wave.instances.some(instance => instance.isDouble))
    .map(wave => wave.waveOrdinal);
  if (schedule.firstTeachingBatchWaveOneDoubleSuppressed && doubleWaves.includes(1)) {
    throw new Error("first teaching batch wave-one suppression violated");
  }
  if (config.doublePatternId === "NONE" && doubleWaves.length !== 0) throw new Error("NONE double pattern violated");
  if (config.doublePatternId === "MAX2_CONSEC" && maximumConsecutive(doubleWaves) > 2) throw new Error("MAX2_CONSEC violated");
  if (config.doublePatternId === "MAX3_CONSEC" && maximumConsecutive(doubleWaves) > 3) throw new Error("MAX3_CONSEC violated");

  const projection = {...schedule} as Record<string, unknown>;
  delete projection.scheduleSha256;
  if (canonicalSha256(projection) !== schedule.scheduleSha256) throw new Error("scheduleSha256 is inconsistent");

  // Constraint checks above provide actionable diagnostics. This final replay
  // check proves that every PRNG decision (target, distractors, quotas, double
  // waves and slots) is exactly reproducible from the declared inputs, even if
  // a forged schedule has had its own hash recomputed after semantic tampering.
  const regenerated = buildBatchScheduleUnchecked(config, schedule.sessionSeed, schedule.batchOrdinal, {
    backgroundIdOverride: schedule.backgroundId,
    firstFormalTeachingBatch: schedule.firstTeachingBatchWaveOneDoubleSuppressed,
  });
  if (canonicalSha256(schedule) !== canonicalSha256(regenerated)) {
    throw new Error("schedule differs from deterministic generator replay");
  }
}
