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
import type {
  LevelConfig, SignalStationRuntimeConfig, TimingProfile, TimingProfileId,
} from "../types.js";

const SOURCE_WORKBOOK_SHA256 = "b16fbcef60fa63214338af8f436e42e0080fe254fe89a9fa42a5256abde81620";
const REQUIREMENT_DOCUMENT_SHA256 = "c9823a24ee41d536a1401a0c233d7ed8be81e4fb7076716fafed09df3f6ac898";
const PUBLIC_RULES_DOCUMENT_SHA256 = "c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794";

const LEVEL_CONFIG_KEYS = Object.freeze([
  "level", "stageId", "gridRows", "gridColumns", "timingProfile", "waveTemplate",
  "targetClassCount", "targetClassSplit", "similarityTier", "directionCount",
  "doubleCount", "doubleWaveOrdinals", "maxWaveObjects",
] as const);
const TIMING_PROFILE_KEYS = Object.freeze([
  "id", "enteringMs", "activeMs", "exitingMs", "lifecycleMs", "gapMs", "tailBufferMs", "doubleWindowMs",
] as const);
const RUNTIME_CONFIG_KEYS = Object.freeze([
  "schemaVersion", "requirementVersion", "generatorVersion", "scoringRuleVersion", "contentVersion",
  "sourceWorkbookSha256", "requirementDocumentSha256", "publicRulesDocumentSha256",
  "durationMs", "plannedBatchCount", "batchDurationMs", "cueDurationMs", "operationDurationMs",
  "feedbackDurationMs", "transitionDurationMs", "waveStartOffsetsMs", "timingProfiles", "levelConfigs",
  "fullLevelSetStatus",
] as const);

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
  sourceWorkbookSha256: SOURCE_WORKBOOK_SHA256,
  requirementDocumentSha256: REQUIREMENT_DOCUMENT_SHA256,
  publicRulesDocumentSha256: PUBLIC_RULES_DOCUMENT_SHA256,
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

function requireRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function requireInteger(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be a safe integer in [${min}, ${max}]`);
  }
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const frozen = [...expected].sort();
  if (actual.length !== frozen.length || actual.some((key, index) => key !== frozen[index])) {
    throw new Error(`${name} keys do not match the frozen contract`);
  }
}

function requireSha256(value: unknown, expected: string, name: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase SHA-256`);
  if (value !== expected) throw new Error(`${name} does not match the frozen source`);
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireNumberArray(value: unknown, name: string): asserts value is number[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  for (const item of value) requireInteger(item, `${name} item`, 0, Number.MAX_SAFE_INTEGER);
}

function assertTimingProfileMatches(actual: TimingProfile, expected: TimingProfile, timingId: TimingProfileId): void {
  requireExactKeys(actual as unknown as Record<string, unknown>, TIMING_PROFILE_KEYS, `timingProfiles.${timingId}`);
  for (const key of TIMING_PROFILE_KEYS) {
    if (actual[key] !== expected[key]) throw new Error(`timingProfiles.${timingId}.${key} mismatch`);
  }
}

function assertLevelConfigMatches(actual: LevelConfig, expected: LevelConfig): void {
  for (const key of LEVEL_CONFIG_KEYS) {
    const left = actual[key];
    const right = expected[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      if (!arraysEqual(left, right)) throw new Error(`level ${expected.level} ${key} mismatch`);
    } else if (left !== right) {
      throw new Error(`level ${expected.level} ${key} mismatch`);
    }
  }
}

export function isVerticalSliceLevelImplemented(level: number): boolean {
  return Number.isSafeInteger(level) && level >= 1 && level <= 96
    && Object.prototype.hasOwnProperty.call(LEVEL_CONFIGS, String(level));
}

export function getVerticalSliceLevelConfig(level: number): LevelConfig {
  requireInteger(level, "level", 1, 96);
  const config = LEVEL_CONFIGS[String(level)];
  if (config === undefined) throw new Error(`level ${level} is not implemented in the six-level vertical slice`);
  return config;
}

export function validateLevelConfig(config: unknown): asserts config is LevelConfig {
  requireRecord(config, "levelConfig");
  requireExactKeys(config, LEVEL_CONFIG_KEYS, "levelConfig");
  requireInteger(config["level"], "level", 1, 96);
  if (!["S01", "S02", "S12", "S14", "S15", "S16"].includes(String(config["stageId"]))) {
    throw new Error("unsupported stageId");
  }
  requireInteger(config["gridRows"], "gridRows", 2, 3);
  requireInteger(config["gridColumns"], "gridColumns", 2, 4);
  requireInteger(config["maxWaveObjects"], "maxWaveObjects", 1, 5);
  requireInteger(config["doubleCount"], "doubleCount", 0, 8);
  requireInteger(config["similarityTier"], "similarityTier", 0, 3);
  requireInteger(config["directionCount"], "directionCount", 1, 4);
  requireInteger(config["targetClassCount"], "targetClassCount", 1, 2);
  if (!["A", "C", "H"].includes(String(config["timingProfile"]))) throw new Error("unsupported timingProfile");
  if (![1, 2, 4].includes(config["directionCount"] as number)) throw new Error("directionCount must be 1, 2, or 4");
  if (!["P10_D0", "P15_D5", "P20_D5", "P20_D10"].includes(String(config["waveTemplate"]))) {
    throw new Error("unsupported waveTemplate");
  }
  requireNumberArray(config["targetClassSplit"], "targetClassSplit");
  requireNumberArray(config["doubleWaveOrdinals"], "doubleWaveOrdinals");

  const typed = config as unknown as LevelConfig;
  if (typed.gridRows * typed.gridColumns < typed.maxWaveObjects) throw new Error("grid cannot hold maxWaveObjects");
  const template = WAVE_TEMPLATES[typed.waveTemplate];
  if (template.targetCounts.length !== 8 || template.distractorCounts.length !== 8) throw new Error("wave template must contain 8 waves");
  const targetTotal = template.targetCounts.reduce((sum, value) => sum + value, 0);
  const distractorTotal = template.distractorCounts.reduce((sum, value) => sum + value, 0);
  if (targetTotal !== template.targetTotal || distractorTotal !== template.distractorTotal) throw new Error("wave template totals mismatch");
  if (typed.targetClassSplit.length !== typed.targetClassCount) throw new Error("targetClassSplit length mismatch");
  if (typed.targetClassSplit.some(value => value <= 0)) throw new Error("each target class must contain at least one target");
  if (typed.targetClassSplit.reduce((sum, value) => sum + value, 0) !== template.targetTotal) throw new Error("targetClassSplit total mismatch");
  if (typed.targetClassCount === 2 && typed.waveTemplate !== "P20_D10") throw new Error("dual-target slice requires P20_D10");
  if (typed.similarityTier === 0 && template.distractorTotal !== 0) throw new Error("similarity tier 0 cannot contain distractors");
  if (typed.similarityTier > 0 && template.distractorTotal === 0) throw new Error("distractor tiers require distractors");

  for (let index = 0; index < 8; index += 1) {
    const targetCount = template.targetCounts[index]!;
    const distractorCount = template.distractorCounts[index]!;
    if (targetCount > 3) throw new Error(`wave ${index + 1} exceeds target cap`);
    if (distractorCount > 2) throw new Error(`wave ${index + 1} exceeds distractor cap`);
    if (targetCount + distractorCount > typed.maxWaveObjects || targetCount + distractorCount > 5) {
      throw new Error(`wave ${index + 1} exceeds object cap`);
    }
  }
  if (typed.doubleWaveOrdinals.length !== typed.doubleCount) throw new Error("doubleCount mismatch");
  let previousWave = 0;
  for (const waveOrdinal of typed.doubleWaveOrdinals) {
    requireInteger(waveOrdinal, "doubleWaveOrdinal", 1, 8);
    if (waveOrdinal <= previousWave) throw new Error("doubleWaveOrdinals must be unique and strictly increasing");
    if (template.targetCounts[waveOrdinal - 1] === 0) throw new Error("double wave must contain a target");
    previousWave = waveOrdinal;
  }
}

export function validateRuntimeConfig(config: unknown): asserts config is SignalStationRuntimeConfig {
  requireRecord(config, "runtimeConfig");
  requireExactKeys(config, RUNTIME_CONFIG_KEYS, "runtimeConfig");
  if (config["schemaVersion"] !== SIGNAL_STATION_CONFIG_VERSION) throw new Error("config schemaVersion mismatch");
  if (config["requirementVersion"] !== SIGNAL_STATION_REQUIREMENT_VERSION) throw new Error("requirementVersion mismatch");
  if (config["generatorVersion"] !== SIGNAL_STATION_GENERATOR_VERSION) throw new Error("generatorVersion mismatch");
  if (config["scoringRuleVersion"] !== SIGNAL_STATION_SCORING_RULE_VERSION) throw new Error("scoringRuleVersion mismatch");
  if (config["contentVersion"] !== SIGNAL_STATION_CONTENT_VERSION) throw new Error("contentVersion mismatch");
  requireSha256(config["sourceWorkbookSha256"], SOURCE_WORKBOOK_SHA256, "sourceWorkbookSha256");
  requireSha256(config["requirementDocumentSha256"], REQUIREMENT_DOCUMENT_SHA256, "requirementDocumentSha256");
  requireSha256(config["publicRulesDocumentSha256"], PUBLIC_RULES_DOCUMENT_SHA256, "publicRulesDocumentSha256");
  if (config["durationMs"] !== SESSION_DURATION_MS || config["plannedBatchCount"] !== PLANNED_BATCH_COUNT) {
    throw new Error("session constants mismatch");
  }
  if (config["batchDurationMs"] !== BATCH_DURATION_MS
    || config["cueDurationMs"] !== CUE_DURATION_MS
    || config["operationDurationMs"] !== OPERATION_DURATION_MS
    || config["feedbackDurationMs"] !== FEEDBACK_DURATION_MS
    || config["transitionDurationMs"] !== TRANSITION_DURATION_MS) {
    throw new Error("batch phase constants mismatch");
  }
  requireNumberArray(config["waveStartOffsetsMs"], "waveStartOffsetsMs");
  if (!arraysEqual(config["waveStartOffsetsMs"], WAVE_START_OFFSETS_MS)) throw new Error("wave start offsets mismatch");
  if (config["fullLevelSetStatus"] !== "HOLD") throw new Error("full 96-level set must remain HOLD");

  requireRecord(config["timingProfiles"], "timingProfiles");
  requireExactKeys(config["timingProfiles"], ["A", "C", "H"], "timingProfiles");
  for (const timingId of ["A", "C", "H"] as const satisfies readonly TimingProfileId[]) {
    const profileValue = config["timingProfiles"][timingId];
    requireRecord(profileValue, `timingProfiles.${timingId}`);
    const profile = profileValue as unknown as TimingProfile;
    assertTimingProfileMatches(profile, TIMING_PROFILES[timingId], timingId);
    if (profile.enteringMs + profile.activeMs + profile.exitingMs !== profile.lifecycleMs) throw new Error(`${timingId} lifecycle mismatch`);
    if (profile.lifecycleMs + profile.gapMs !== 3_500) throw new Error(`${timingId} lifecycle+gap mismatch`);
    if (WAVE_START_OFFSETS_MS[7]! + profile.lifecycleMs + profile.tailBufferMs !== OPERATION_DURATION_MS) {
      throw new Error(`${timingId} final wave does not close at operation end`);
    }
    if (profile.doubleWindowMs < 1_000) throw new Error(`${timingId} double window below minimum`);
  }

  requireRecord(config["levelConfigs"], "levelConfigs");
  const expectedLevelKeys = IMPLEMENTED_VERTICAL_SLICE_LEVELS.map(String);
  requireExactKeys(config["levelConfigs"], expectedLevelKeys, "levelConfigs");
  for (const level of IMPLEMENTED_VERTICAL_SLICE_LEVELS) {
    const levelConfigValue = config["levelConfigs"][String(level)];
    validateLevelConfig(levelConfigValue);
    const expected = LEVEL_CONFIGS[String(level)];
    if (expected === undefined) throw new Error(`internal representative level ${level} is missing`);
    assertLevelConfigMatches(levelConfigValue, expected);
  }
}

validateRuntimeConfig(VERTICAL_SLICE_RUNTIME_CONFIG);
