import { canonicalSha256 } from "../../canonical.js";
import { FRUIT_POOLS, fruitsAreSimilar, gridDefinition } from "./assets.js";
import { levelConfig, waveProfile } from "./config.js";
import { prngFor, type XorShift32 } from "./prng.js";
import {
  CATCH_LIGHT_CONFIG_SET_ID,
  CATCH_LIGHT_GENERATOR_VERSION,
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
  if (!Number.isInteger(quota) || quota < 0 || quota > total) throw new Error(`invalid quota ${quota}/${total}`);
  const selected = new Set(prng.shuffle(Array.from({length: total}, (_, index) => index)).slice(0, quota));
  return Array.from({length: total}, (_, index) => selected.has(index));
}

function maximumConsecutive(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let best = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]! + 1) current += 1;
    else current = 1;
    if (current > best) best = current;
  }
  return best;
}

function enumerateWaveSelections(count: number, forbiddenWaveOne: boolean, maxConsecutive: number): number[][] {
  const candidates = Array.from({length: WAVE_COUNT}, (_, index) => index + 1).filter(wave => !forbiddenWaveOne || wave !== 1);
  const result: number[][] = [];
  const recurse = (start: number, selected: number[]): void => {
    if (selected.length === count) {
      if (maximumConsecutive(selected) <= maxConsecutive) result.push([...selected]);
      return;
    }
    for (let index = start; index < candidates.length; index += 1) {
      selected.push(candidates[index]!);
      recurse(index + 1, selected);
      selected.pop();
    }
  };
  recurse(0, []);
  return result;
}

function chooseDoubleWaves(config: CatchLightLevelConfig, prng: XorShift32): Set<number> {
  if (config.doubleTargetCount === 0) return new Set<number>();
  const forbiddenWaveOne = config.doublePatternId === "SEP_NO_W1";
  const maxConsecutive = config.doublePatternId === "MAX3_CONSEC" ? 3 : config.doublePatternId === "MAX2_CONSEC" ? 2 : 1;
  const combinations = enumerateWaveSelections(config.doubleTargetCount, forbiddenWaveOne, maxConsecutive);
  if (combinations.length === 0) throw new Error(`${config.seedKey}: no legal double-target wave allocation`);
  const selected = prng.shuffle(combinations)[0]!;
  return new Set(selected);
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
    if (index === 0 && previousPrimaryTargetSlot !== null && candidates.length > 1) {
      const alternatives = candidates.filter(slot => slot.slotId !== previousPrimaryTargetSlot);
      if (alternatives.length > 0) candidates = alternatives;
    }
    const slot = prng.shuffle(candidates)[0]!;
    assignments.set(index, slot);
    available.delete(slot.slotId);
  }
  return assignments;
}

function scheduleProjection(schedule: Omit<GeneratedBatchSchedule, "scheduleSha256">): Omit<GeneratedBatchSchedule, "scheduleSha256"> {
  return schedule;
}

export function generateBatchSchedule(
  levelOrConfig: number | CatchLightLevelConfig,
  sessionSeed: number,
  batchOrdinal: number,
  backgroundIdOverride?: string,
): GeneratedBatchSchedule {
  const config = typeof levelOrConfig === "number" ? levelConfig(levelOrConfig) : levelOrConfig;
  const profile = waveProfile(config.waveProfileId);
  const targetsByWave = rotated(profile.targetsByWave, config.waveRotation);
  const distractorsByWave = rotated(profile.distractorsByWave, config.waveRotation);
  const batchPlan = prngFor(config.seedKey, sessionSeed, batchOrdinal, 0);
  const pool = FRUIT_POOLS[config.fruitPoolId];
  const targetFruitId = batchPlan.prng.shuffle(pool)[0]!;
  const similarFlags = quotaFlags(config.distractorTotal, config.similarDistractorCount, batchPlan.prng);
  const targetEdgeFlags = quotaFlags(config.targetTotal, config.targetFarEdgeCount, batchPlan.prng);
  const distractorEdgeFlags = quotaFlags(config.distractorTotal, config.distractorFarEdgeCount, batchPlan.prng);
  const doubleWaves = chooseDoubleWaves(config, batchPlan.prng);
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
      const similar = similarFlags[distractorGlobalOrdinal]!;
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
    previousPrimaryTargetSlot = instances.find(instance => instance.role === "TARGET")!.slotId;
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
    backgroundId: backgroundIdOverride ?? config.backgroundId,
    gridId: config.gridId,
    targetTotal: config.targetTotal,
    distractorTotal: config.distractorTotal,
    sameScreenCap: config.sameScreenCap,
    waves,
  };
  const schedule: GeneratedBatchSchedule = {...projection, scheduleSha256: canonicalSha256(scheduleProjection(projection))};
  validateGeneratedSchedule(schedule, config);
  return schedule;
}

export function validateGeneratedSchedule(schedule: GeneratedBatchSchedule, config: CatchLightLevelConfig = levelConfig(schedule.level)): void {
  if (schedule.waves.length !== WAVE_COUNT) throw new Error("generated schedule must have eight waves");
  const all = schedule.waves.flatMap(wave => wave.instances);
  const targets = all.filter(instance => instance.role === "TARGET");
  const distractors = all.filter(instance => instance.role === "DISTRACTOR");
  if (targets.length !== config.targetTotal || distractors.length !== config.distractorTotal) throw new Error("generated T/D totals mismatch config");
  if (new Set(all.map(instance => instance.instanceId)).size !== all.length) throw new Error("duplicate instanceId");
  if (targets.some(instance => instance.fruitId !== schedule.targetFruitId)) throw new Error("batch target fruit is not fixed");
  if (distractors.some(instance => instance.fruitId === schedule.targetFruitId)) throw new Error("target fruit reused as distractor");
  if (distractors.filter(instance => instance.similarityClass === "SIMILAR").length !== config.similarDistractorCount) throw new Error("similar distractor quota mismatch");
  if (targets.filter(instance => instance.edgeEmphasis).length !== config.targetFarEdgeCount) throw new Error("target edge-emphasis quota mismatch");
  if (distractors.filter(instance => instance.edgeEmphasis).length !== config.distractorFarEdgeCount) throw new Error("distractor edge-emphasis quota mismatch");
  if (targets.filter(instance => instance.isDouble).length !== config.doubleTargetCount) throw new Error("double-target quota mismatch");
  const doubleWaves = schedule.waves.filter(wave => wave.instances.some(instance => instance.isDouble)).map(wave => wave.waveOrdinal);
  if (schedule.waves.some(wave => wave.instances.filter(instance => instance.isDouble).length > 1)) throw new Error("more than one double target in a wave");
  if (config.doublePatternId === "SEP_NO_W1" && (doubleWaves.includes(1) || maximumConsecutive(doubleWaves) > 1)) throw new Error("SEP_NO_W1 violated");
  if (config.doublePatternId === "MAX2_CONSEC" && maximumConsecutive(doubleWaves) > 2) throw new Error("MAX2_CONSEC violated");
  if (config.doublePatternId === "MAX3_CONSEC" && maximumConsecutive(doubleWaves) > 3) throw new Error("MAX3_CONSEC violated");
  for (const wave of schedule.waves) {
    if (wave.instances.length > config.sameScreenCap) throw new Error("sameScreenCap violated");
    if (new Set(wave.instances.map(instance => instance.slotId)).size !== wave.instances.length) throw new Error("slot collision within wave");
    const distractorIds = wave.instances.filter(instance => instance.role === "DISTRACTOR").map(instance => instance.fruitId);
    if (new Set(distractorIds).size !== distractorIds.length) throw new Error("duplicate distractor fruit within wave");
  }
  for (let waveIndex = 1; waveIndex < schedule.waves.length; waveIndex += 1) {
    const previous = schedule.waves[waveIndex - 1]!.instances.find(instance => instance.role === "TARGET")!.slotId;
    const current = schedule.waves[waveIndex]!.instances.find(instance => instance.role === "TARGET")!.slotId;
    if (previous === current) throw new Error("primary target slot repeated in adjacent waves");
  }
  const projection = {...schedule} as Record<string, unknown>;
  delete projection.scheduleSha256;
  if (canonicalSha256(projection) !== schedule.scheduleSha256) throw new Error("scheduleSha256 is inconsistent");
}
