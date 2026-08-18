import {
  BATCH_DURATION_MS,
  CUE_DURATION_MS,
  FEEDBACK_DURATION_MS,
  IMPLEMENTED_VERTICAL_SLICE_LEVELS,
  OPERATION_DURATION_MS,
  PLANNED_BATCH_COUNT,
  SESSION_DURATION_MS,
  SIGNAL_STATION_CONFIG_VERSION,
  SIGNAL_STATION_CONTENT_VERSION,
  SIGNAL_STATION_GENERATOR_VERSION,
  SIGNAL_STATION_REQUIREMENT_VERSION,
  SIGNAL_STATION_SCORING_RULE_VERSION,
  TIMING_PROFILES,
  TRANSITION_DURATION_MS,
  WAVE_START_OFFSETS_MS,
  WAVE_TEMPLATES,
} from "../constants.js";
import type { LevelConfig, SignalStationRuntimeConfig, TimingProfileId } from "../types.js";

const LEVEL_CONFIGS: Readonly<Record<string, LevelConfig>> = Object.freeze({
  "1": Object.freeze({
    level: 1, stageId: "S01", gridRows: 2, gridColumns: 2, timingProfile: "A",
    waveTemplate: "P10_D0", targetClassCount: 1, targetClassSplit: Object.freeze([10]),
    similarityTier: 0, directionCount: 1, doubleCount: 0,
    doubleWaveOrdinals: Object.freeze([]), maxWaveObjects: 2,
  }),
  "7": Object.freeze({
    level: 7, stageId: "S02", gridRows: 2, gridColumns: 2, timingProfile: "A",
    waveTemplate: "P15_D5", targetClassCount: 1, targetClassSplit: Object.freeze([15]),
    similarityTier: 1, directionCount: 1, doubleCount: 0,
    doubleWaveOrdinals: Object.freeze([]), maxWaveObjects: 3,
  }),
  "67": Object.freeze({
    level: 67, stageId: "S12", gridRows: 3, gridColumns: 4, timingProfile: "A",
    waveTemplate: "P20_D10", targetClassCount: 2, targetClassSplit: Object.freeze([10, 10]),
    similarityTier: 1, directionCount: 2, doubleCount: 0,
    doubleWaveOrdinals: Object.freeze([]), maxWaveObjects: 5,
  }),
  "79": Object.freeze({
    level: 79, stageId: "S14", gridRows: 3, gridColumns: 4, timingProfile: "A",
    waveTemplate: "P20_D10", targetClassCount: 1, targetClassSplit: Object.freeze([20]),
    similarityTier: 1, directionCount: 2, doubleCount: 2,
    doubleWaveOrdinals: Object.freeze([3, 7]), maxWaveObjects: 5,
  }),
  "90": Object.freeze({
    level: 90, stageId: "S15", gridRows: 3, gridColumns: 4, timingProfile: "H",
    waveTemplate: "P20_D10", targetClassCount: 2, targetClassSplit: Object.freeze([10, 10]),
    similarityTier: 2, directionCount: 4, doubleCount: 4,
    doubleWaveOrdinals: Object.freeze([2, 4, 6, 8]), maxWaveObjects: 5,
  }),
  "96": Object.freeze({
    level: 96, stageId: "S16", gridRows: 3, gridColumns: 4, timingProfile: "H",
    waveTemplate: "P20_D10", targetClassCount: 2, targetClassSplit: Object.freeze([10, 10]),
    similarityTier: 3, directionCount: 4, doubleCount: 5,
    doubleWaveOrdinals: Object.freeze([1, 2, 4, 6, 8]), maxWaveObjects: 5,
  }),
});

export const VERTICAL_SLICE_RUNTIME_CONFIG: SignalStationRuntimeConfig = Object.freeze({
  schemaVersion: SIGNAL_STATION_CONFIG_VERSION,
  requirementVersion: SIGNAL_STATION_REQUIREMENT_VERSION,
  generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
  scoringRuleVersion: SIGNAL_STATION_SCORING_RULE_VERSION,
  contentVersion: SIGNAL_STATION_CONTENT_VERSION,
  sourceWorkbookSha256: "b16fbcef60fa63214338af8f436e42e0080fe254fe89a9fa42a5256abde81620",
  requirementDocumentSha256: "c9823a24ee41d536a1401a0c233d7ed8be81e4fb7076716fafed09df3f6ac898",
  publicRulesDocumentSha256: "c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794",
  durationMs: SESSION_DURATION_MS,
  plannedBatchCount: PLANNED_BATCH_COUNT,
  batchDurationMs: BATCH_DURATION_MS,
  cueDurationMs: CUE_DURATION_MS,
  operationDurationMs: OPERATION_DURATION_MS,
  feedbackDurationMs: FEEDBACK_DURATION_MS,
  transitionDurationMs: TRANSITION_DURATION_MS,
  waveStartOffsetsMs: WAVE_START_OFFSETS_MS,
  timingProfiles: TIMING_PROFILES,
  levelConfigs: LEVEL_CONFIGS,
  fullLevelSetStatus: "HOLD",
});

function requireInteger(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be a safe integer in [${min}, ${max}]`);
  }
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function getVerticalSliceLevelConfig(level: number): LevelConfig {
  requireInteger(level, "level", 1, 96);
  const config = VERTICAL_SLICE_RUNTIME_CONFIG.levelConfigs[String(level)];
  if (config === undefined) {
    throw new Error(`level ${level} is not implemented in the six-level vertical slice`);
  }
  return config;
}

export function validateLevelConfig(config: LevelConfig): void {
  requireInteger(config.level, "level", 1, 96);
  requireInteger(config.gridRows, "gridRows", 2, 3);
  requireInteger(config.gridColumns, "gridColumns", 2, 4);
  requireInteger(config.maxWaveObjects, "maxWaveObjects", 1, 5);
  requireInteger(config.doubleCount, "doubleCount", 0, 8);
  if (!["A", "C", "H"].includes(config.timingProfile)) throw new Error("unsupported timingProfile");
  if (![1, 2, 4].includes(config.directionCount)) throw new Error("directionCount must be 1, 2, or 4");
  if (config.similarityTier < 0 || config.similarityTier > 3) throw new Error("similarityTier must be in [0,3]");
  if (config.targetClassCount !== 1 && config.targetClassCount !== 2) throw new Error("targetClassCount must be 1 or 2");
  if (config.gridRows * config.gridColumns < config.maxWaveObjects) throw new Error("grid cannot hold maxWaveObjects");

  const template = WAVE_TEMPLATES[config.waveTemplate];
  if (template === undefined) throw new Error(`unknown wave template ${config.waveTemplate}`);
  if (template.targetCounts.length !== 8 || template.distractorCounts.length !== 8) throw new Error("wave template must contain 8 waves");
  const targetTotal = template.targetCounts.reduce((sum, value) => sum + value, 0);
  const distractorTotal = template.distractorCounts.reduce((sum, value) => sum + value, 0);
  if (targetTotal !== template.targetTotal || distractorTotal !== template.distractorTotal) throw new Error("wave template totals mismatch");
  if (config.targetClassSplit.length !== config.targetClassCount) throw new Error("targetClassSplit length mismatch");
  if (config.targetClassSplit.reduce((sum, value) => sum + value, 0) !== template.targetTotal) throw new Error("targetClassSplit total mismatch");
  if (config.targetClassCount === 2 && config.waveTemplate !== "P20_D10") throw new Error("dual-target slice requires P20_D10");
  if (config.similarityTier === 0 && template.distractorTotal !== 0) throw new Error("similarity tier 0 cannot contain distractors");
  if (config.similarityTier > 0 && template.distractorTotal === 0) throw new Error("distractor tiers require distractors");

  for (let index = 0; index < 8; index += 1) {
    const targetCount = template.targetCounts[index]!;
    const distractorCount = template.distractorCounts[index]!;
    if (targetCount > 3) throw new Error(`wave ${index + 1} exceeds target cap`);
    if (distractorCount > 2) throw new Error(`wave ${index + 1} exceeds distractor cap`);
    if (targetCount + distractorCount > config.maxWaveObjects || targetCount + distractorCount > 5) {
      throw new Error(`wave ${index + 1} exceeds object cap`);
    }
  }
  if (config.doubleWaveOrdinals.length !== config.doubleCount) throw new Error("doubleCount mismatch");
  const uniqueDoubleWaves = new Set(config.doubleWaveOrdinals);
  if (uniqueDoubleWaves.size !== config.doubleWaveOrdinals.length) throw new Error("duplicate double wave ordinal");
  for (const waveOrdinal of config.doubleWaveOrdinals) requireInteger(waveOrdinal, "doubleWaveOrdinal", 1, 8);
}

export function validateRuntimeConfig(config: SignalStationRuntimeConfig): void {
  if (config.schemaVersion !== SIGNAL_STATION_CONFIG_VERSION) throw new Error("config schemaVersion mismatch");
  if (config.requirementVersion !== SIGNAL_STATION_REQUIREMENT_VERSION) throw new Error("requirementVersion mismatch");
  if (config.generatorVersion !== SIGNAL_STATION_GENERATOR_VERSION) throw new Error("generatorVersion mismatch");
  if (config.scoringRuleVersion !== SIGNAL_STATION_SCORING_RULE_VERSION) throw new Error("scoringRuleVersion mismatch");
  if (config.contentVersion !== SIGNAL_STATION_CONTENT_VERSION) throw new Error("contentVersion mismatch");
  if (config.durationMs !== SESSION_DURATION_MS || config.plannedBatchCount !== PLANNED_BATCH_COUNT) throw new Error("session constants mismatch");
  if (config.batchDurationMs !== BATCH_DURATION_MS) throw new Error("batchDurationMs mismatch");
  if (config.cueDurationMs + config.operationDurationMs + config.feedbackDurationMs + config.transitionDurationMs !== BATCH_DURATION_MS) {
    throw new Error("batch phase durations do not close at 37500ms");
  }
  if (!arraysEqual(config.waveStartOffsetsMs, WAVE_START_OFFSETS_MS)) throw new Error("wave start offsets mismatch");
  if (config.fullLevelSetStatus !== "HOLD") throw new Error("full 96-level set must remain HOLD");
  for (const timingId of ["A", "C", "H"] as const satisfies readonly TimingProfileId[]) {
    const profile = config.timingProfiles[timingId];
    if (profile.enteringMs + profile.activeMs + profile.exitingMs !== profile.lifecycleMs) throw new Error(`${timingId} lifecycle mismatch`);
    if (profile.lifecycleMs + profile.gapMs !== 3_500) throw new Error(`${timingId} lifecycle+gap mismatch`);
    if (WAVE_START_OFFSETS_MS[7]! + profile.lifecycleMs + profile.tailBufferMs !== OPERATION_DURATION_MS) {
      throw new Error(`${timingId} final wave does not close at operation end`);
    }
    if (profile.doubleWindowMs < 1_000) throw new Error(`${timingId} double window below minimum`);
  }
  const actualLevels = Object.keys(config.levelConfigs).map(Number).sort((a, b) => a - b);
  if (!arraysEqual(actualLevels, IMPLEMENTED_VERTICAL_SLICE_LEVELS)) throw new Error("vertical-slice level set mismatch");
  for (const level of IMPLEMENTED_VERTICAL_SLICE_LEVELS) {
    const levelConfig = config.levelConfigs[String(level)];
    if (levelConfig === undefined) throw new Error(`missing representative level ${level}`);
    validateLevelConfig(levelConfig);
  }
}

validateRuntimeConfig(VERTICAL_SLICE_RUNTIME_CONFIG);
