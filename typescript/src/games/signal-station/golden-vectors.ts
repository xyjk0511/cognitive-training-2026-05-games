import { canonicalSha256 } from "../../canonical.js";
import {
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
    harness.advanceToActiveMs(37_500);
    const resultDraft = harness.finalizeAtDeadline();
    const eligibleBatch = resultDraft.eligibleBatches[0];
    if (eligibleBatch === undefined) throw new Error(`golden L${level} did not close a batch`);
    return {
      id: `SIGNAL_STATION_L${level}_SEED_${seed}`,
      level,
      sessionSeed: seed,
      levelConfig: getVerticalSliceLevelConfig(level),
      planSha256: canonicalSha256(plan),
      plan,
      expectedBatch: eligibleBatch,
      resultDraft,
    };
  });
  return {
    vectorVersion: "A620-SS-GOLDEN-1.2.1",
    generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
    scoringRuleVersion: SIGNAL_STATION_SCORING_RULE_VERSION,
    runtimeConfigHash,
    vectors,
  };
}
