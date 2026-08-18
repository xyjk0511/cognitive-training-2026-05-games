import { DESIGN_MAX_LEVEL, type LevelDecision } from "./types.js";

function assertBatchCounts(H: number, T: number, F: number, D: number): void {
  for (const [label, value] of [["H", H], ["T", T], ["F", F], ["D", D]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  }
  if (T <= 0 || H > T) throw new Error("require 0 <= H <= T and T > 0");
  if (D !== 0 && D !== 5 && D !== 10) throw new Error("D must be exactly 0, 5, or 10");
  if (F > D) throw new Error("F cannot exceed D");
}

export function roundHalfUpFraction(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) throw new Error("numerator must be a non-negative safe integer");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error("denominator must be a positive safe integer");
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  return quotient + (remainder * 2 >= denominator ? 1 : 0);
}

export function resultZone(H: number, T: number, F: number, D: number): "UPGRADE" | "HOLD" | "FAIL" {
  assertBatchCounts(H, T, F, D);
  const upgradeFalseLimit = D === 0 ? 0 : D === 5 ? 1 : 2;
  const holdFalseLimit = D === 0 ? 0 : D === 5 ? 2 : 3;
  if (H * 100 >= T * 80 && F <= upgradeFalseLimit) return "UPGRADE";
  if (H * 100 >= T * 70 && F <= holdFalseLimit) return "HOLD";
  return "FAIL";
}

export function batchScore(H: number, T: number, F: number, D: number, zone: "UPGRADE" | "HOLD" | "FAIL" = resultZone(H, T, F, D)): number {
  assertBatchCounts(H, T, F, D);
  const bonus = zone === "UPGRADE" ? 10 : 0;
  if (D === 0) return roundHalfUpFraction(90 * H, T) + bonus;
  return roundHalfUpFraction(70 * H, T) + roundHalfUpFraction(20 * (D - F), D) + bonus;
}

export function applyLevelDecision(levelBefore: number, zone: "UPGRADE" | "HOLD" | "FAIL", consecutiveFailBefore: 0 | 1): LevelDecision {
  if (!Number.isInteger(levelBefore) || levelBefore < 1 || levelBefore > DESIGN_MAX_LEVEL) throw new Error("levelBefore outside 1..120");
  if (consecutiveFailBefore !== 0 && consecutiveFailBefore !== 1) throw new Error("consecutiveFailBefore must be 0 or 1");
  if (zone === "UPGRADE") {
    return levelBefore === DESIGN_MAX_LEVEL
      ? {resultZone:zone, levelTransition:"HOLD_MAX", levelAfter:DESIGN_MAX_LEVEL, consecutiveFailAfter:0}
      : {resultZone:zone, levelTransition:"UP", levelAfter:levelBefore + 1, consecutiveFailAfter:0};
  }
  if (zone === "HOLD") return {resultZone:zone, levelTransition:"HOLD", levelAfter:levelBefore, consecutiveFailAfter:0};
  if (consecutiveFailBefore === 0) return {resultZone:zone, levelTransition:"RETRY", levelAfter:levelBefore, consecutiveFailAfter:1};
  return levelBefore === 1
    ? {resultZone:zone, levelTransition:"HOLD_MIN", levelAfter:1, consecutiveFailAfter:0}
    : {resultZone:zone, levelTransition:"DOWN", levelAfter:levelBefore - 1, consecutiveFailAfter:0};
}
