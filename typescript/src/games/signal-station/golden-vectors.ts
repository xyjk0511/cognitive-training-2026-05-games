import { canonicalSha256 } from "../../canonical.js";
import {
  BATCH_DURATION_MS,
  SIGNAL_STATION_GENERATOR_VERSION,
  SIGNAL_STATION_SCORING_RULE_VERSION,
} from "./constants.js";
import { getVerticalSliceLevelConfig, VERTICAL_SLICE_RUNTIME_CONFIG } from "./config/vertical-slices.js";
import { SignalStationHeadlessHarness } from "./adapter/headless-harness.js";

const FIXED_SEEDS: Readonly<Record<string, number>> = Object.freeze({
  "1": 6_201_001,
  "7": 6_201_007,
  "67": 6_201_067,
  "79": 6_201_079,
  "90": 6_201_090,
  "96": 6_201_096,
});

function buildCoverageBoundaryVectors(runtimeConfigHash: string) {
  const upward = new SignalStationHeadlessHarness({
    sessionSeed: 6_202_001,
    sessionStartLevel: 1,
    runtimeConfigHash,
  });
  const upwardPlan = upward.beginBatchAt(0);
  upward.respondToCurrentBatch({targetHits: 8, falseTouches: 0, reactionOffsetMs: 5});
  upward.advanceToActiveMs(BATCH_DURATION_MS);
  const upwardBlock = upward.session.markVerticalSliceCoverageBlocked();
  const upwardPlans = upward.session.closedPlans();
  if (upwardPlans[0] !== upwardPlan) throw new Error("upward coverage plan identity drifted");
  const upwardDraft = upward.finalizeAtDeadline();

  const downward = new SignalStationHeadlessHarness({
    sessionSeed: 6_202_096,
    sessionStartLevel: 96,
    runtimeConfigHash,
  });
  downward.runClosedBatches(2, {targetHits: 0, falseTouches: 0, reactionOffsetMs: 5});
  const downwardBlock = downward.session.markVerticalSliceCoverageBlocked();
  const downwardPlans = downward.session.closedPlans();
  const downwardDraft = downward.finalizeAtDeadline();

  return Object.freeze([
    Object.freeze({
      id: "SIGNAL_STATION_COVERAGE_L1_TO_L2",
      direction: "UP" as const,
      sessionSeed: 6_202_001,
      fromLevel: 1,
      blockedLevel: 2,
      afterBatchOrdinal: 1,
      plans: upwardPlans,
      planSha256s: Object.freeze(upwardPlans.map(plan => canonicalSha256(plan))),
      coverageBlock: upwardBlock,
      resultDraft: upwardDraft,
    }),
    Object.freeze({
      id: "SIGNAL_STATION_COVERAGE_L96_TO_L95",
      direction: "DOWN" as const,
      sessionSeed: 6_202_096,
      fromLevel: 96,
      blockedLevel: 95,
      afterBatchOrdinal: 2,
      plans: downwardPlans,
      planSha256s: Object.freeze(downwardPlans.map(plan => canonicalSha256(plan))),
      coverageBlock: downwardBlock,
      resultDraft: downwardDraft,
    }),
  ]);
}

export function buildSignalStationGoldenVectors() {
  const runtimeConfigHash = canonicalSha256(VERTICAL_SLICE_RUNTIME_CONFIG);
  const vectors = [1, 7, 67, 79, 90, 96].map(level => {
    const seed = FIXED_SEEDS[String(level)];
    if (seed === undefined) throw new Error(`missing golden seed for L${level}`);
    const harness = new SignalStationHeadlessHarness({sessionSeed: seed, sessionStartLevel: level, runtimeConfigHash});
    const plan = harness.beginBatchAt(0);
    const response = level === 96
      ? Object.freeze({targetHits: 16, falseTouches: 2, reactionOffsetMs: 5, doubleSecondGapMs: 1})
      : SignalStationHeadlessHarness.holdResponseForLevel(level, 5);
    harness.respondToCurrentBatch(response);
    harness.advanceToActiveMs(BATCH_DURATION_MS);
    const resultDraft = harness.finalizeAtDeadline();
    const eligibleBatch = resultDraft.eligibleBatches[0];
    if (eligibleBatch === undefined) throw new Error(`golden L${level} did not close a batch`);
    return Object.freeze({
      id: `SIGNAL_STATION_L${level}_SEED_${seed}`,
      level,
      sessionSeed: seed,
      levelConfig: getVerticalSliceLevelConfig(level),
      planSha256: canonicalSha256(plan),
      plan,
      expectedBatch: eligibleBatch,
      resultDraft,
    });
  });
  return Object.freeze({
    vectorVersion: "A620-SS-GOLDEN-1.2.1-r2" as const,
    generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
    scoringRuleVersion: SIGNAL_STATION_SCORING_RULE_VERSION,
    runtimeConfigHash,
    vectors: Object.freeze(vectors),
    coverageBoundaryVectors: buildCoverageBoundaryVectors(runtimeConfigHash),
  });
}
