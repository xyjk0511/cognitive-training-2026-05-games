import {
  CUE_DURATION_MS,
  DUAL_TARGET_A_COUNTS,
  DUAL_TARGET_B_COUNTS,
  SIGNAL_STATION_GENERATOR_VERSION,
  TIMING_PROFILES,
  WAVE_START_OFFSETS_MS,
  WAVE_TEMPLATES,
} from "../constants.js";
import { validateLevelConfig } from "../config/vertical-slices.js";
import type {
  GeneratedBatchPlan, GeneratedSignalInstance, GeneratedWave, LevelConfig, Quadrant, SignalSymbol, TargetCategoryId,
} from "../types.js";
import { createGeneratorRng, type DeterministicRng } from "./prng.js";
import {
  DIRECTION_POOL,
  generateDistractorSymbol,
  generateTargetCards,
  hasNonColorDifference,
  sharedAttributeCount,
  symbolsEqual,
} from "./symbols.js";

interface Slot {
  readonly slotIndex: number;
  readonly row: number;
  readonly column: number;
  readonly quadrant: Quadrant;
}

function half(index: number, size: number, crossIndex: number): "LOW" | "HIGH" {
  const middle = Math.floor(size / 2);
  if (size % 2 === 0) return index < middle ? "LOW" : "HIGH";
  if (index < middle) return "LOW";
  if (index > middle) return "HIGH";
  return crossIndex % 2 === 0 ? "LOW" : "HIGH";
}

function quadrantFor(row: number, column: number, rows: number, columns: number): Quadrant {
  const vertical = half(row, rows, column) === "LOW" ? "TOP" : "BOTTOM";
  const horizontal = half(column, columns, row) === "LOW" ? "LEFT" : "RIGHT";
  return `${vertical}_${horizontal}` as Quadrant;
}

function allSlots(config: LevelConfig): Slot[] {
  const result: Slot[] = [];
  for (let row = 0; row < config.gridRows; row += 1) {
    for (let column = 0; column < config.gridColumns; column += 1) {
      result.push(Object.freeze({
        slotIndex: row * config.gridColumns + column,
        row,
        column,
        quadrant: quadrantFor(row, column, config.gridRows, config.gridColumns),
      }));
    }
  }
  return result;
}

function targetCategoryCounts(config: LevelConfig, waveIndex: number): Readonly<Record<TargetCategoryId, number>> {
  const template = WAVE_TEMPLATES[config.waveTemplate];
  const total = template.targetCounts[waveIndex]!;
  if (config.targetClassCount === 1) return Object.freeze({A: total, B: 0});
  if (config.waveTemplate !== "P20_D10") throw new Error("dual-target generation requires P20_D10");
  return Object.freeze({A: DUAL_TARGET_A_COUNTS[waveIndex]!, B: DUAL_TARGET_B_COUNTS[waveIndex]!});
}

function balanceCounts(targetSlotsByWave: readonly (readonly Slot[])[]): {left:number;right:number;top:number;bottom:number} {
  const counts = {left: 0, right: 0, top: 0, bottom: 0};
  for (const wave of targetSlotsByWave) {
    for (const slot of wave) {
      if (slot.quadrant.endsWith("LEFT")) counts.left += 1; else counts.right += 1;
      if (slot.quadrant.startsWith("TOP")) counts.top += 1; else counts.bottom += 1;
    }
  }
  return counts;
}

function quadrantSpread(targetSlotsByWave: readonly (readonly Slot[])[]): number {
  const counts: Record<Quadrant, number> = {
    TOP_LEFT: 0, TOP_RIGHT: 0, BOTTOM_LEFT: 0, BOTTOM_RIGHT: 0,
  };
  for (const wave of targetSlotsByWave) for (const slot of wave) counts[slot.quadrant] += 1;
  const values = Object.values(counts);
  return Math.max(...values) - Math.min(...values);
}

function hasTripleTargetCellRepeat(targetSlotsByWave: readonly (readonly Slot[])[]): boolean {
  for (let waveIndex = 2; waveIndex < targetSlotsByWave.length; waveIndex += 1) {
    const current = new Set(targetSlotsByWave[waveIndex]!.map(slot => slot.slotIndex));
    const previous = new Set(targetSlotsByWave[waveIndex - 1]!.map(slot => slot.slotIndex));
    const earlier = new Set(targetSlotsByWave[waveIndex - 2]!.map(slot => slot.slotIndex));
    for (const slotIndex of current) if (previous.has(slotIndex) && earlier.has(slotIndex)) return true;
  }
  return false;
}

function chooseTargetSlots(
  config: LevelConfig,
  sessionSeed: number,
  batchOrdinal: number,
  slots: readonly Slot[],
): readonly (readonly Slot[])[] {
  const template = WAVE_TEMPLATES[config.waveTemplate];
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const targetSlotsByWave: Slot[][] = [];
    const quadrantCounts: Record<Quadrant, number> = {
      TOP_LEFT: 0, TOP_RIGHT: 0, BOTTOM_LEFT: 0, BOTTOM_RIGHT: 0,
    };
    const slotCounts = new Array<number>(slots.length).fill(0);
    let failed = false;

    for (let waveIndex = 0; waveIndex < 8 && !failed; waveIndex += 1) {
      const rng = createGeneratorRng({
        sessionSeed, level: config.level, batchOrdinal, waveOrdinal: waveIndex + 1, scope: `layout-${attempt}`,
      });
      const selected: Slot[] = [];
      const randomizedRank = new Map<number, number>();
      rng.shuffled(slots).forEach((slot, index) => randomizedRank.set(slot.slotIndex, index));
      const forbiddenByTriple = new Set<number>();
      if (waveIndex >= 2) {
        const previous = new Set(targetSlotsByWave[waveIndex - 1]!.map(slot => slot.slotIndex));
        for (const earlier of targetSlotsByWave[waveIndex - 2]!) if (previous.has(earlier.slotIndex)) forbiddenByTriple.add(earlier.slotIndex);
      }

      for (let targetIndex = 0; targetIndex < template.targetCounts[waveIndex]!; targetIndex += 1) {
        const candidates = slots
          .filter(slot => !selected.some(value => value.slotIndex === slot.slotIndex) && !forbiddenByTriple.has(slot.slotIndex))
          .sort((left, right) => {
            const quadrantDifference = quadrantCounts[left.quadrant] - quadrantCounts[right.quadrant];
            if (quadrantDifference !== 0) return quadrantDifference;
            const slotDifference = slotCounts[left.slotIndex]! - slotCounts[right.slotIndex]!;
            if (slotDifference !== 0) return slotDifference;
            const randomDifference = randomizedRank.get(left.slotIndex)! - randomizedRank.get(right.slotIndex)!;
            if (randomDifference !== 0) return randomDifference;
            return left.slotIndex - right.slotIndex;
          });
        const chosen = candidates[0];
        if (chosen === undefined) { failed = true; break; }
        selected.push(chosen);
        quadrantCounts[chosen.quadrant] += 1;
        slotCounts[chosen.slotIndex] = slotCounts[chosen.slotIndex]! + 1;
      }
      targetSlotsByWave.push(selected);
    }

    if (!failed) {
      const balance = balanceCounts(targetSlotsByWave);
      if (Math.abs(balance.left - balance.right) <= 2 && Math.abs(balance.top - balance.bottom) <= 2
        && quadrantSpread(targetSlotsByWave) <= 2
        && !hasTripleTargetCellRepeat(targetSlotsByWave)) {
        return targetSlotsByWave.map(wave => Object.freeze([...wave]));
      }
    }
  }
  throw new Error("unable to satisfy target quadrant/cell-repeat constraints after 256 deterministic attempts");
}

function targetSymbolsList(cards: Readonly<Record<TargetCategoryId, SignalSymbol | null>>): SignalSymbol[] {
  if (cards.A === null) throw new Error("target card A is required");
  const result: SignalSymbol[] = [cards.A];
  if (cards.B !== null) result.push(cards.B);
  return result;
}

function chooseDistractorReference(config: LevelConfig, distractorIndex: number, rng: DeterministicRng): TargetCategoryId {
  if (config.targetClassCount === 1) return "A";
  if (distractorIndex % 2 === 0) return rng.nextInt(2) === 0 ? "A" : "B";
  return rng.nextInt(2) === 0 ? "B" : "A";
}

export function validateGeneratedBatchPlan(plan: GeneratedBatchPlan, config: LevelConfig): void {
  validateLevelConfig(config);
  if (plan.generatorVersion !== SIGNAL_STATION_GENERATOR_VERSION) throw new Error("generated plan version mismatch");
  if (plan.level !== config.level) throw new Error("generated plan level mismatch");
  if (!Number.isSafeInteger(plan.sessionSeed) || plan.sessionSeed < 0) throw new Error("generated plan sessionSeed is invalid");
  if (!Number.isSafeInteger(plan.batchOrdinal) || plan.batchOrdinal < 1 || plan.batchOrdinal > 8) throw new Error("generated plan batchOrdinal is invalid");
  if (plan.waves.length !== 8) throw new Error("generated plan must contain 8 waves");
  const template = WAVE_TEMPLATES[config.waveTemplate];
  const profile = TIMING_PROFILES[config.timingProfile];
  const targetA = plan.targetCards.A;
  const targetB = plan.targetCards.B;
  if (targetA === null) throw new Error("generated plan lacks target card A");
  if (config.targetClassCount === 1 && targetB !== null) throw new Error("single-target plan unexpectedly contains target card B");
  if (config.targetClassCount === 2) {
    if (targetB === null) throw new Error("dual-target plan lacks target card B");
    if (symbolsEqual(targetA, targetB) || !hasNonColorDifference(targetA, targetB)) throw new Error("target cards are not distinctly identifiable");
  }
  const targetCards = [targetA, ...(targetB === null ? [] : [targetB])];
  const allowedDirections = new Set(DIRECTION_POOL.slice(0, config.directionCount));
  const expectedDoubleWaves = new Set(config.doubleWaveOrdinals);
  const instanceIds = new Set<string>();
  const targetCategoryTotals: Record<TargetCategoryId, number> = {A: 0, B: 0};
  let targets = 0;
  let distractors = 0;
  let doubles = 0;
  const targetSlotsByWave: Slot[][] = [];
  for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
    const wave = plan.waves[waveIndex]!;
    const expectedWaveOrdinal = waveIndex + 1;
    if (wave.waveOrdinal !== expectedWaveOrdinal) throw new Error("generated wave ordinal mismatch");
    if (wave.startOffsetInOperationMs !== WAVE_START_OFFSETS_MS[waveIndex]) throw new Error("generated wave start offset mismatch");
    if (wave.instances.length > 5 || wave.instances.length > config.maxWaveObjects) throw new Error("generated wave exceeds object cap");
    const waveTargets = wave.instances.filter(instance => instance.role === "TARGET");
    const waveDistractors = wave.instances.filter(instance => instance.role === "DISTRACTOR");
    if (waveTargets.length !== template.targetCounts[waveIndex]) throw new Error("generated wave target count mismatch");
    if (waveDistractors.length !== template.distractorCounts[waveIndex]) throw new Error("generated wave distractor count mismatch");
    if (waveTargets.length > 3 || waveDistractors.length > 2) throw new Error("generated wave role cap exceeded");
    const waveDoubleCount = wave.instances.filter(instance => instance.requiresDouble).length;
    if (waveDoubleCount > 1) throw new Error("generated wave has more than one double target");
    if (waveDoubleCount !== (expectedDoubleWaves.has(expectedWaveOrdinal) ? 1 : 0)) throw new Error("generated wave double-target placement mismatch");
    if (new Set(wave.instances.map(instance => instance.slotIndex)).size !== wave.instances.length) throw new Error("generated wave reuses a slot");

    const expectedCategories = targetCategoryCounts(config, waveIndex);
    if (waveTargets.filter(instance => instance.targetCategoryId === "A").length !== expectedCategories.A
      || waveTargets.filter(instance => instance.targetCategoryId === "B").length !== expectedCategories.B) {
      throw new Error("generated wave target-category pattern mismatch");
    }

    const expectedEnterStart = CUE_DURATION_MS + WAVE_START_OFFSETS_MS[waveIndex]!;
    const expectedNaturalEnd = expectedEnterStart + profile.lifecycleMs;
    for (const instance of wave.instances) {
      if (instanceIds.has(instance.instanceId)) throw new Error("generated plan contains duplicate instanceId");
      instanceIds.add(instance.instanceId);
      if (instance.batchOrdinal !== plan.batchOrdinal || instance.waveOrdinal !== expectedWaveOrdinal) throw new Error("generated instance identity mismatch");
      if (instance.instanceId !== `b${plan.batchOrdinal}-w${expectedWaveOrdinal}-s${instance.slotIndex}`) throw new Error("generated instanceId is not canonical");
      if (instance.enterStartInBatchMs !== expectedEnterStart || instance.naturalExitEndInBatchMs !== expectedNaturalEnd) {
        throw new Error("generated instance timing mismatch");
      }
      if (!Number.isSafeInteger(instance.slotIndex) || instance.slotIndex < 0 || instance.slotIndex >= config.gridRows * config.gridColumns) {
        throw new Error("generated instance slot is outside the grid");
      }
      const expectedRow = Math.floor(instance.slotIndex / config.gridColumns);
      const expectedColumn = instance.slotIndex % config.gridColumns;
      if (instance.row !== expectedRow || instance.column !== expectedColumn
        || instance.quadrant !== quadrantFor(expectedRow, expectedColumn, config.gridRows, config.gridColumns)) {
        throw new Error("generated instance grid coordinates mismatch");
      }
      if (!allowedDirections.has(instance.symbol.directionDeg)) throw new Error("generated symbol uses a disabled direction");

      if (instance.role === "TARGET") {
        if (instance.targetCategoryId === null || instance.similarityReferenceTargetCategoryId !== null) throw new Error("generated target category fields are invalid");
        const targetCard = plan.targetCards[instance.targetCategoryId];
        if (targetCard === null || !symbolsEqual(instance.symbol, targetCard)) throw new Error("generated target does not match its target card");
        targetCategoryTotals[instance.targetCategoryId] += 1;
      } else {
        if (instance.targetCategoryId !== null || instance.similarityReferenceTargetCategoryId === null || instance.requiresDouble) {
          throw new Error("generated distractor role fields are invalid");
        }
        const reference = plan.targetCards[instance.similarityReferenceTargetCategoryId];
        if (reference === null) throw new Error("generated distractor reference target is absent");
        if (targetCards.some(target => symbolsEqual(instance.symbol, target))) throw new Error("generated distractor duplicates a target card");
        if (targetCards.some(target => !hasNonColorDifference(instance.symbol, target))) {
          throw new Error("color is the sole distractor difference from at least one target card");
        }
        const shared = sharedAttributeCount(instance.symbol, reference);
        if (config.similarityTier === 1) {
          if (instance.symbol.contour === reference.contour || instance.symbol.innerMark === reference.innerMark
            || instance.symbol.colorFamily === reference.colorFamily
            || (config.directionCount > 1 && instance.symbol.directionDeg === reference.directionDeg)) {
            throw new Error("tier-1 distractor is not markedly different");
          }
        } else if (config.similarityTier === 2 && shared !== 1) {
          throw new Error("tier-2 distractor must share exactly one attribute");
        } else if (config.similarityTier === 3 && shared !== 2) {
          throw new Error("tier-3 distractor must share exactly two attributes");
        }
      }
    }
    targets += waveTargets.length;
    distractors += waveDistractors.length;
    doubles += waveTargets.filter(instance => instance.requiresDouble).length;
    targetSlotsByWave.push(waveTargets.map(instance => ({
      slotIndex: instance.slotIndex, row: instance.row, column: instance.column, quadrant: instance.quadrant,
    })));
  }
  if (plan.targetTotal !== template.targetTotal || plan.distractorTotal !== template.distractorTotal || plan.doubleTotal !== config.doubleCount) {
    throw new Error("generated plan declared totals mismatch");
  }
  if (targets !== plan.targetTotal || distractors !== plan.distractorTotal || doubles !== plan.doubleTotal) throw new Error("generated plan totals mismatch");
  if (targetCategoryTotals.A !== config.targetClassSplit[0]
    || targetCategoryTotals.B !== (config.targetClassSplit[1] ?? 0)) throw new Error("generated target-class split mismatch");
  const balance = balanceCounts(targetSlotsByWave);
  if (Math.abs(balance.left - balance.right) > 2 || Math.abs(balance.top - balance.bottom) > 2
    || quadrantSpread(targetSlotsByWave) > 2) throw new Error("generated target layout is unbalanced");
  if (hasTripleTargetCellRepeat(targetSlotsByWave)) throw new Error("generated target slot repeats for three consecutive waves");
}

export function generateBatchPlan(config: LevelConfig, sessionSeed: number, batchOrdinal: number): GeneratedBatchPlan {
  validateLevelConfig(config);
  if (!Number.isSafeInteger(sessionSeed) || sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
  if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 1 || batchOrdinal > 8) throw new Error("batchOrdinal must be in [1,8]");
  const slots = allSlots(config);
  const targetSlotsByWave = chooseTargetSlots(config, sessionSeed, batchOrdinal, slots);
  const cardRng = createGeneratorRng({sessionSeed, level: config.level, batchOrdinal, waveOrdinal: 0, scope: "target-cards"});
  const targetCards = generateTargetCards(config.targetClassCount, config.directionCount, cardRng);
  const allTargets = targetSymbolsList(targetCards);
  const template = WAVE_TEMPLATES[config.waveTemplate];
  const profile = TIMING_PROFILES[config.timingProfile];
  const waves: GeneratedWave[] = [];

  for (let waveIndex = 0; waveIndex < 8; waveIndex += 1) {
    const waveOrdinal = waveIndex + 1;
    const rng = createGeneratorRng({sessionSeed, level: config.level, batchOrdinal, waveOrdinal, scope: "wave-content"});
    const targetSlots = targetSlotsByWave[waveIndex]!;
    const usedSlots = new Set(targetSlots.map(slot => slot.slotIndex));
    const freeSlots = rng.shuffled(slots.filter(slot => !usedSlots.has(slot.slotIndex)));
    const categoryCounts = targetCategoryCounts(config, waveIndex);
    const categories = rng.shuffled([
      ...new Array<TargetCategoryId>(categoryCounts.A).fill("A"),
      ...new Array<TargetCategoryId>(categoryCounts.B).fill("B"),
    ]);
    if (categories.length !== targetSlots.length) throw new Error("target category pattern does not match target count");
    const doubleTargetIndex = config.doubleWaveOrdinals.includes(waveOrdinal) ? rng.nextInt(targetSlots.length) : -1;
    const instances: GeneratedSignalInstance[] = [];
    const enterStartInBatchMs = CUE_DURATION_MS + WAVE_START_OFFSETS_MS[waveIndex]!;
    const naturalExitEndInBatchMs = enterStartInBatchMs + profile.lifecycleMs;

    for (let targetIndex = 0; targetIndex < targetSlots.length; targetIndex += 1) {
      const slot = targetSlots[targetIndex]!;
      const targetCategoryId = categories[targetIndex]!;
      const symbol = targetCards[targetCategoryId];
      if (symbol === null) throw new Error("generated target category lacks a target card");
      instances.push(Object.freeze({
        instanceId: `b${batchOrdinal}-w${waveOrdinal}-s${slot.slotIndex}`,
        batchOrdinal,
        waveOrdinal,
        role: "TARGET",
        targetCategoryId,
        similarityReferenceTargetCategoryId: null,
        requiresDouble: targetIndex === doubleTargetIndex,
        slotIndex: slot.slotIndex,
        row: slot.row,
        column: slot.column,
        quadrant: slot.quadrant,
        symbol,
        enterStartInBatchMs,
        naturalExitEndInBatchMs,
      }));
    }

    for (let distractorIndex = 0; distractorIndex < template.distractorCounts[waveIndex]!; distractorIndex += 1) {
      const slot = freeSlots[distractorIndex];
      if (slot === undefined) throw new Error("not enough free grid slots for distractors");
      const referenceCategory = chooseDistractorReference(config, distractorIndex, rng);
      const reference = targetCards[referenceCategory];
      if (reference === null) throw new Error("distractor reference category is unavailable");
      const symbol = generateDistractorSymbol(reference, allTargets, config.similarityTier, config.directionCount, rng);
      instances.push(Object.freeze({
        instanceId: `b${batchOrdinal}-w${waveOrdinal}-s${slot.slotIndex}`,
        batchOrdinal,
        waveOrdinal,
        role: "DISTRACTOR",
        targetCategoryId: null,
        similarityReferenceTargetCategoryId: referenceCategory,
        requiresDouble: false,
        slotIndex: slot.slotIndex,
        row: slot.row,
        column: slot.column,
        quadrant: slot.quadrant,
        symbol,
        enterStartInBatchMs,
        naturalExitEndInBatchMs,
      }));
    }

    instances.sort((left, right) => left.slotIndex - right.slotIndex);
    waves.push(Object.freeze({
      waveOrdinal,
      startOffsetInOperationMs: WAVE_START_OFFSETS_MS[waveIndex]!,
      instances: Object.freeze(instances),
    }));
  }

  const plan: GeneratedBatchPlan = Object.freeze({
    generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
    sessionSeed,
    level: config.level,
    batchOrdinal,
    targetCards,
    waves: Object.freeze(waves),
    targetTotal: template.targetTotal,
    distractorTotal: template.distractorTotal,
    doubleTotal: config.doubleCount,
  });
  validateGeneratedBatchPlan(plan, config);
  return plan;
}
