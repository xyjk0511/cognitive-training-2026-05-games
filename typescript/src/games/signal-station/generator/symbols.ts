import type {
  ColorFamily, Contour, DirectionDeg, InnerMark, SignalSymbol, SimilarityTier, TargetCategoryId,
} from "../types.js";
import type { DeterministicRng } from "./prng.js";

export const CONTOUR_POOL = Object.freeze([
  "CIRCLE", "ROUNDED_SQUARE", "TRIANGLE", "DIAMOND", "HEXAGON", "SHIELD",
] as const satisfies readonly Contour[]);
export const INNER_MARK_POOL = Object.freeze([
  "DOT", "BAR", "DOUBLE_BAR", "CROSS", "CHEVRON", "ARC",
] as const satisfies readonly InnerMark[]);
export const DIRECTION_POOL = Object.freeze([0, 90, 180, 270] as const satisfies readonly DirectionDeg[]);
export const COLOR_POOL = Object.freeze(["BLUE", "TEAL", "AMBER", "VIOLET"] as const satisfies readonly ColorFamily[]);

const ATTRIBUTE_KEYS = Object.freeze(["contour", "innerMark", "directionDeg", "colorFamily"] as const);
type AttributeKey = typeof ATTRIBUTE_KEYS[number];

function differentValue<T>(pool: readonly T[], current: T, rng: DeterministicRng): T {
  const alternatives = pool.filter(value => value !== current);
  if (alternatives.length === 0) throw new Error("symbol constraint requires an unavailable alternative");
  return rng.choose(alternatives);
}

function randomSymbol(directionCount: 1 | 2 | 4, rng: DeterministicRng): SignalSymbol {
  return Object.freeze({
    contour: rng.choose(CONTOUR_POOL),
    innerMark: rng.choose(INNER_MARK_POOL),
    directionDeg: rng.choose(DIRECTION_POOL.slice(0, directionCount)),
    colorFamily: rng.choose(COLOR_POOL),
  });
}

export function symbolsEqual(left: SignalSymbol, right: SignalSymbol): boolean {
  return ATTRIBUTE_KEYS.every(key => left[key] === right[key]);
}

export function sharedAttributeCount(left: SignalSymbol, right: SignalSymbol): number {
  return ATTRIBUTE_KEYS.reduce((sum, key) => sum + (left[key] === right[key] ? 1 : 0), 0);
}

export function hasNonColorDifference(left: SignalSymbol, right: SignalSymbol): boolean {
  return left.contour !== right.contour || left.innerMark !== right.innerMark || left.directionDeg !== right.directionDeg;
}

export function generateTargetCards(
  targetClassCount: 1 | 2,
  directionCount: 1 | 2 | 4,
  rng: DeterministicRng,
): Readonly<Record<TargetCategoryId, SignalSymbol | null>> {
  const targetA = randomSymbol(directionCount, rng);
  if (targetClassCount === 1) return Object.freeze({A: targetA, B: null});

  for (let attempt = 0; attempt < 256; attempt += 1) {
    const targetB = randomSymbol(directionCount, rng);
    if (!symbolsEqual(targetA, targetB) && hasNonColorDifference(targetA, targetB)) {
      return Object.freeze({A: targetA, B: targetB});
    }
  }
  throw new Error("unable to generate two distinguishable target cards");
}

function buildTierOne(reference: SignalSymbol, directionCount: 1 | 2 | 4, rng: DeterministicRng): SignalSymbol {
  const directions = DIRECTION_POOL.slice(0, directionCount);
  return Object.freeze({
    contour: differentValue(CONTOUR_POOL, reference.contour, rng),
    innerMark: differentValue(INNER_MARK_POOL, reference.innerMark, rng),
    directionDeg: directions.length === 1 ? reference.directionDeg : differentValue(directions, reference.directionDeg, rng),
    colorFamily: differentValue(COLOR_POOL, reference.colorFamily, rng),
  });
}

function buildExactSharedCount(
  reference: SignalSymbol,
  desiredSharedCount: 1 | 2,
  directionCount: 1 | 2 | 4,
  rng: DeterministicRng,
): SignalSymbol {
  const directions = DIRECTION_POOL.slice(0, directionCount);
  const immutableKeys: AttributeKey[] = directions.length === 1 ? ["directionDeg"] : [];
  if (immutableKeys.length > desiredSharedCount) throw new Error("similarity tier cannot be represented by the active pools");
  const selectable = ATTRIBUTE_KEYS.filter(key => !immutableKeys.includes(key));
  const extraShared = rng.shuffled(selectable).slice(0, desiredSharedCount - immutableKeys.length);
  const shared = new Set<AttributeKey>([...immutableKeys, ...extraShared]);
  const candidate: SignalSymbol = Object.freeze({
    contour: shared.has("contour") ? reference.contour : differentValue(CONTOUR_POOL, reference.contour, rng),
    innerMark: shared.has("innerMark") ? reference.innerMark : differentValue(INNER_MARK_POOL, reference.innerMark, rng),
    directionDeg: shared.has("directionDeg") ? reference.directionDeg : differentValue(directions, reference.directionDeg, rng),
    colorFamily: shared.has("colorFamily") ? reference.colorFamily : differentValue(COLOR_POOL, reference.colorFamily, rng),
  });
  if (sharedAttributeCount(reference, candidate) !== desiredSharedCount) throw new Error("similarity construction drifted");
  if (!hasNonColorDifference(reference, candidate)) throw new Error("color cannot be the sole distinguishing cue");
  return candidate;
}

export function generateDistractorSymbol(
  reference: SignalSymbol,
  allTargets: readonly SignalSymbol[],
  similarityTier: SimilarityTier,
  directionCount: 1 | 2 | 4,
  rng: DeterministicRng,
): SignalSymbol {
  if (similarityTier === 0) throw new Error("tier 0 does not generate distractors");
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const candidate = similarityTier === 1
      ? buildTierOne(reference, directionCount, rng)
      : buildExactSharedCount(reference, similarityTier === 2 ? 1 : 2, directionCount, rng);
    if (allTargets.every(target => !symbolsEqual(candidate, target) && hasNonColorDifference(candidate, target))) {
      return candidate;
    }
  }
  throw new Error("unable to generate a globally distinguishable distractor under the requested similarity constraints");
}
