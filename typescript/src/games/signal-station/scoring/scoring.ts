import type {
  LevelDecision, LevelTransition, ResultZone, ScoreDecision, WaveTemplateId,
} from "../types.js";

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

export function roundHalfUpRatio(numerator: number, denominator: number): number {
  assertCount(numerator, "numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error("denominator must be a positive safe integer");
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  // Comparing against ceil(denominator / 2) is equivalent to 2r >= d but
  // does not multiply a potentially near-MAX_SAFE_INTEGER remainder.
  return quotient + (remainder >= Math.ceil(denominator / 2) ? 1 : 0);
}

export function decideResultZone(template: WaveTemplateId, H: number, T: number, F: number, D: number): ResultZone {
  for (const [name, value] of [["H", H], ["T", T], ["F", F], ["D", D]] as const) assertCount(value, name);
  if (H > T) throw new Error("H cannot exceed T");
  if (F > D) throw new Error("F cannot exceed D");
  const expected: Readonly<Record<WaveTemplateId, readonly [number, number]>> = {
    P10_D0: [10, 0], P15_D5: [15, 5], P20_D5: [20, 5], P20_D10: [20, 10],
  };
  const expectedCounts = expected[template];
  if (expectedCounts === undefined) throw new Error(`unsupported wave template ${String(template)}`);
  if (T !== expectedCounts[0] || D !== expectedCounts[1]) throw new Error(`${template} requires T/D=${expectedCounts.join("/")}`);

  switch (template) {
    case "P10_D0":
      if (H >= 8) return "UPGRADE";
      if (H >= 7) return "HOLD";
      return "FAIL";
    case "P15_D5":
      if (H >= 12 && F <= 1) return "UPGRADE";
      if (H >= 11 && F <= 1) return "HOLD";
      return "FAIL";
    case "P20_D5":
      if (H >= 16 && F <= 1) return "UPGRADE";
      if (H >= 14 && F <= 1) return "HOLD";
      return "FAIL";
    case "P20_D10":
      if (H >= 16 && F <= 2) return "UPGRADE";
      if (H >= 14 && F <= 3) return "HOLD";
      return "FAIL";
  }
}

export function scoreBatch(template: WaveTemplateId, H: number, T: number, F: number, D: number): ScoreDecision {
  const resultZone = decideResultZone(template, H, T, F, D);
  const hitScore = roundHalfUpRatio((D === 0 ? 90 : 70) * H, T);
  const inhibitionScore = D === 0 ? 0 : roundHalfUpRatio(20 * (D - F), D);
  const upgradeBonus = resultZone === "UPGRADE" ? 10 : 0;
  const batchScore = hitScore + inhibitionScore + upgradeBonus;
  if (batchScore < 0 || batchScore > 100) throw new Error("batchScore outside [0,100]");
  return Object.freeze({resultZone, batchScore});
}

export function decideLevelTransition(levelBefore: number, resultZone: ResultZone, consecutiveFailCountBefore: 0 | 1): LevelDecision {
  if (!Number.isSafeInteger(levelBefore) || levelBefore < 1 || levelBefore > 96) throw new Error("levelBefore must be in [1,96]");
  if (resultZone !== "UPGRADE" && resultZone !== "HOLD" && resultZone !== "FAIL") throw new Error("unsupported resultZone");
  if (consecutiveFailCountBefore !== 0 && consecutiveFailCountBefore !== 1) throw new Error("consecutiveFailCountBefore must be 0 or 1");
  let levelTransition: LevelTransition;
  let levelAfter = levelBefore;
  let consecutiveFailCountAfter: 0 | 1 = 0;
  if (resultZone === "UPGRADE") {
    levelTransition = levelBefore === 96 ? "HOLD_MAX" : "UP";
    levelAfter = Math.min(levelBefore + 1, 96);
  } else if (resultZone === "HOLD") {
    levelTransition = "HOLD";
  } else if (consecutiveFailCountBefore === 0) {
    levelTransition = "RETRY";
    consecutiveFailCountAfter = 1;
  } else {
    levelTransition = levelBefore === 1 ? "HOLD_MIN" : "DOWN";
    levelAfter = Math.max(levelBefore - 1, 1);
  }
  return Object.freeze({levelTransition, levelAfter, consecutiveFailCountAfter});
}
