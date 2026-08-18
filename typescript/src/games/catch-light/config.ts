import { FRUIT_CATALOG, FRUIT_POOLS, GRID_CATALOG } from "./assets.js";
import { canonicalSha256 } from "../../canonical.js";
import {
  A620_PUBLIC_RULES_SHA256,
  BATCH_DURATION_MS,
  CATCH_LIGHT_CONFIG_SCHEMA_ID,
  CATCH_LIGHT_CONFIG_SET_ID,
  CATCH_LIGHT_CONFIG_VERSION,
  CATCH_LIGHT_GAME_CODE,
  CATCH_LIGHT_GENERATOR_VERSION,
  CATCH_LIGHT_QA_SEED,
  CATCH_LIGHT_REQUIREMENT_SHA256,
  CATCH_LIGHT_RESULT_SCHEMA_VERSION,
  CATCH_LIGHT_SCORING_RULE_VERSION,
  CATCH_LIGHT_SOURCE_WORKBOOK_NAME,
  CATCH_LIGHT_SOURCE_WORKBOOK_ROLE,
  CATCH_LIGHT_SOURCE_WORKBOOK_SHA256,
  DESIGN_MAX_LEVEL,
  ENTER_ANIMATION_MS,
  EXIT_ANIMATION_MS,
  FIRST_WAVE_MS,
  HIT_FEEDBACK_MS,
  OPERATION_DURATION_MS,
  PLANNED_BATCH_COUNT,
  SESSION_DURATION_MS,
  WAVE_COUNT,
  WAVE_ONSET_INTERVAL_MS,
  type CatchLightGameConfig,
  type CatchLightLevelConfig,
  type FruitPoolId,
  type GridId,
  type TimingBand,
  type WaveProfile,
} from "./types.js";

export const WAVE_PROFILES: readonly WaveProfile[] = Object.freeze([
  {waveProfileId:"W10N", targetsByWave:[1,1,2,1,1,2,1,1], distractorsByWave:[0,0,0,0,0,0,0,0]},
  {waveProfileId:"W15D4", targetsByWave:[1,2,2,2,1,2,2,3], distractorsByWave:[1,0,1,0,2,0,1,0]},
  {waveProfileId:"W20D10-C6", targetsByWave:[3,2,3,2,3,2,3,2], distractorsByWave:[0,2,1,2,0,2,1,2]},
  {waveProfileId:"W25D10-C6", targetsByWave:[3,3,3,3,4,3,3,3], distractorsByWave:[0,2,1,2,0,2,1,2]},
  {waveProfileId:"W25D10-C8", targetsByWave:[2,3,3,4,3,3,4,3], distractorsByWave:[1,1,2,1,1,2,1,1]},
]);

function lifecycleFor(band: TimingBand): {stimulusLifecycleMs:number; activeHoldMs:number; interWaveBlankMs:number; postLastBufferMs:number} {
  switch (band) {
    case "A": return {stimulusLifecycleMs:3300, activeHoldMs:2900, interWaveBlankMs:350, postLastBufferMs:650};
    case "C": return {stimulusLifecycleMs:3200, activeHoldMs:2800, interWaveBlankMs:450, postLastBufferMs:750};
    case "H": return {stimulusLifecycleMs:3100, activeHoldMs:2700, interWaveBlankMs:550, postLastBufferMs:850};
  }
}

interface LevelInput {
  level: number;
  difficultyStateId: string;
  stageNo: number;
  timingBand: TimingBand;
  repetitionIndex: number;
  repetitionRole: string;
  contentVariantId: string;
  fruitPoolId: FruitPoolId;
  waveRotation: number;
  backgroundId: string;
  gridId: GridId;
  targetTotal: number;
  distractorTotal: 0 | 5 | 10;
  sameScreenCap: number;
  waveProfileId: string;
  coexistWaveCount: number;
  peakWaveCount: number;
  similarDistractorCount: number;
  targetFarEdgeCount: number;
  distractorFarEdgeCount: number;
  doubleTargetCount: number;
  doubleWindowMs: number;
  doublePatternId: CatchLightLevelConfig["doublePatternId"];
  minTargetHits: number;
  upgradeFalseLimit: number;
  holdFalseLimit: number;
  layoutPoolId: string;
  seedKey: string;
  ruleIntroFlag: CatchLightLevelConfig["ruleIntroFlag"];
}

function level(input: LevelInput): CatchLightLevelConfig {
  const timing = lifecycleFor(input.timingBand);
  return Object.freeze({
    ...input,
    waveCount: WAVE_COUNT,
    roundActiveMs: OPERATION_DURATION_MS,
    firstWaveMs: FIRST_WAVE_MS,
    waveSpacingMs: WAVE_ONSET_INTERVAL_MS,
    ...timing,
    enterAnimationMs: ENTER_ANIMATION_MS,
    exitAnimationMs: EXIT_ANIMATION_MS,
    hitFeedbackMs: HIT_FEEDBACK_MS,
    scoringProfileId: input.distractorTotal === 0 ? "SC_NO_DISTRACTOR" : "SC_WITH_DISTRACTOR",
    backgroundLockRule: "HIGHEST_UNLOCKED_CHAPTER_SESSION_LOCK",
    interactionProfileId: "CL_CHILD_V1",
  });
}

export const VERTICAL_SLICE_LEVELS: readonly CatchLightLevelConfig[] = Object.freeze([
  level({
    level:1,difficultyStateId:"DS01",stageNo:1,timingBand:"A",repetitionIndex:1,repetitionRole:"新授",
    contentVariantId:"DS01-V1",fruitPoolId:"FP_CORE_A",waveRotation:0,backgroundId:"BG01",gridId:"2x2",
    targetTotal:10,distractorTotal:0,sameScreenCap:2,waveProfileId:"W10N",coexistWaveCount:0,peakWaveCount:2,
    similarDistractorCount:0,targetFarEdgeCount:0,distractorFarEdgeCount:0,doubleTargetCount:0,doubleWindowMs:0,
    doublePatternId:"NONE",minTargetHits:8,upgradeFalseLimit:0,holdFalseLimit:0,layoutPoolId:"LP_S01_A_V1",
    seedKey:"CL-L001-DS01-V1",ruleIntroFlag:"FULL_RULE",
  }),
  level({
    level:28,difficultyStateId:"DS10",stageNo:4,timingBand:"A",repetitionIndex:1,repetitionRole:"新授",
    contentVariantId:"DS10-V1",fruitPoolId:"FP_CORE_A",waveRotation:0,backgroundId:"BG02",gridId:"2x3",
    targetTotal:15,distractorTotal:5,sameScreenCap:3,waveProfileId:"W15D4",coexistWaveCount:4,peakWaveCount:4,
    similarDistractorCount:0,targetFarEdgeCount:0,distractorFarEdgeCount:0,doubleTargetCount:0,doubleWindowMs:0,
    doublePatternId:"NONE",minTargetHits:12,upgradeFalseLimit:1,holdFalseLimit:2,layoutPoolId:"LP_S04_A_V1",
    seedKey:"CL-L028-DS10-V1",ruleIntroFlag:"DISTRACTOR_RULE",
  }),
  level({
    level:67,difficultyStateId:"DS23",stageNo:9,timingBand:"A",repetitionIndex:1,repetitionRole:"新授",
    contentVariantId:"DS23-V1",fruitPoolId:"FP_CORE_A",waveRotation:0,backgroundId:"BG05",gridId:"3x3",
    targetTotal:20,distractorTotal:10,sameScreenCap:4,waveProfileId:"W20D10-C6",coexistWaveCount:6,peakWaveCount:6,
    similarDistractorCount:2,targetFarEdgeCount:0,distractorFarEdgeCount:0,doubleTargetCount:0,doubleWindowMs:0,
    doublePatternId:"NONE",minTargetHits:16,upgradeFalseLimit:2,holdFalseLimit:3,layoutPoolId:"LP_S09_A_V1",
    seedKey:"CL-L067-DS23-V1",ruleIntroFlag:"NONE",
  }),
  level({
    level:102,difficultyStateId:"DS38",stageNo:14,timingBand:"A",repetitionIndex:1,repetitionRole:"新授",
    contentVariantId:"DS38-V1",fruitPoolId:"FP_CORE_A",waveRotation:0,backgroundId:"BG07",gridId:"3x4",
    targetTotal:25,distractorTotal:10,sameScreenCap:5,waveProfileId:"W25D10-C6",coexistWaveCount:6,peakWaveCount:4,
    similarDistractorCount:2,targetFarEdgeCount:10,distractorFarEdgeCount:4,doubleTargetCount:2,doubleWindowMs:1500,
    doublePatternId:"SEP_NO_W1",minTargetHits:20,upgradeFalseLimit:2,holdFalseLimit:3,layoutPoolId:"LP_S14_A_V1",
    seedKey:"CL-L102-DS38-V1",ruleIntroFlag:"DOUBLE_RULE",
  }),
  level({
    level:120,difficultyStateId:"DS46",stageNo:16,timingBand:"H",repetitionIndex:2,repetitionRole:"巩固",
    contentVariantId:"DS46-V2",fruitPoolId:"FP_CORE_B",waveRotation:1,backgroundId:"BG08",gridId:"3x4",
    targetTotal:25,distractorTotal:10,sameScreenCap:5,waveProfileId:"W25D10-C8",coexistWaveCount:8,peakWaveCount:4,
    similarDistractorCount:6,targetFarEdgeCount:15,distractorFarEdgeCount:6,doubleTargetCount:6,doubleWindowMs:1200,
    doublePatternId:"MAX3_CONSEC",minTargetHits:20,upgradeFalseLimit:2,holdFalseLimit:3,layoutPoolId:"LP_S16_H_V2",
    seedKey:"CL-L120-DS46-V2",ruleIntroFlag:"NONE",
  }),
]);

const LEVEL_BY_NUMBER = new Map(VERTICAL_SLICE_LEVELS.map(config => [config.level, config]));
const WAVE_PROFILE_BY_ID = new Map(WAVE_PROFILES.map(profile => [profile.waveProfileId, profile]));

export const CATCH_LIGHT_VERTICAL_SLICE_CONFIG: CatchLightGameConfig = Object.freeze({
  schemaVersion: CATCH_LIGHT_CONFIG_VERSION,
  gameCode: CATCH_LIGHT_GAME_CODE,
  gameConfigSchemaId: CATCH_LIGHT_CONFIG_SCHEMA_ID,
  generatorVersion: CATCH_LIGHT_GENERATOR_VERSION,
  scoringRuleVersion: CATCH_LIGHT_SCORING_RULE_VERSION,
  resultSchemaVersion: CATCH_LIGHT_RESULT_SCHEMA_VERSION,
  durationMs: SESSION_DURATION_MS,
  plannedBatchCount: PLANNED_BATCH_COUNT,
  designMaxLevel: DESIGN_MAX_LEVEL,
  qaSeed: CATCH_LIGHT_QA_SEED,
  configSetId: CATCH_LIGHT_CONFIG_SET_ID,
  sourceWorkbookName: CATCH_LIGHT_SOURCE_WORKBOOK_NAME,
  sourceWorkbookSha256: CATCH_LIGHT_SOURCE_WORKBOOK_SHA256,
  sourceWorkbookRole: CATCH_LIGHT_SOURCE_WORKBOOK_ROLE,
  sourceRequirementSha256: CATCH_LIGHT_REQUIREMENT_SHA256,
  publicRulesSha256: A620_PUBLIC_RULES_SHA256,
  fruitCatalogVersion: "catch-light-fruit-catalog-1",
  layoutCatalogVersion: "catch-light-grid-catalog-1",
  fruitCatalog: FRUIT_CATALOG,
  fruitPools: FRUIT_POOLS,
  grids: GRID_CATALOG,
  waveProfiles: WAVE_PROFILES,
  levels: VERTICAL_SLICE_LEVELS,
});

export function levelConfig(levelNumber: number): CatchLightLevelConfig {
  const value = LEVEL_BY_NUMBER.get(levelNumber);
  if (value === undefined) {
    throw new Error(`level ${levelNumber} is not present in the W2 vertical-slice set; no nearest-level fallback is allowed`);
  }
  return value;
}

export function waveProfile(profileId: string): WaveProfile {
  const value = WAVE_PROFILE_BY_ID.get(profileId);
  if (value === undefined) throw new Error(`unknown waveProfileId: ${profileId}`);
  return value;
}

function assertInteger(value: number, label: string, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
}

export function validateLevelConfig(config: CatchLightLevelConfig, suppliedProfile?: WaveProfile): void {
  assertInteger(config.level, "level", 1);
  if (config.level > DESIGN_MAX_LEVEL) throw new Error("level exceeds design maximum");
  const profile = suppliedProfile ?? waveProfile(config.waveProfileId);
  if (profile.waveProfileId !== config.waveProfileId) throw new Error(`${config.seedKey}: wave profile identity mismatch`);
  if (profile.targetsByWave.length !== WAVE_COUNT || profile.distractorsByWave.length !== WAVE_COUNT) {
    throw new Error(`${config.waveProfileId}: wave profile must contain exactly ${WAVE_COUNT} waves`);
  }
  if (!Number.isInteger(config.waveRotation) || config.waveRotation < 0 || config.waveRotation >= WAVE_COUNT) {
    throw new Error(`${config.seedKey}: waveRotation must be in [0, ${WAVE_COUNT - 1}]`);
  }
  const targetSum = profile.targetsByWave.reduce((sum, count) => sum + count, 0);
  const distractorSum = profile.distractorsByWave.reduce((sum, count) => sum + count, 0);
  if (targetSum !== config.targetTotal) throw new Error(`${config.seedKey}: targetTotal does not match wave profile`);
  if (distractorSum !== config.distractorTotal) throw new Error(`${config.seedKey}: distractorTotal does not match wave profile`);

  let actualCoexistWaveCount = 0;
  let actualPeakWaveCount = 0;
  for (let i = 0; i < WAVE_COUNT; i += 1) {
    const targetCount = profile.targetsByWave[(i + config.waveRotation) % WAVE_COUNT]!;
    const distractorCount = profile.distractorsByWave[(i + config.waveRotation) % WAVE_COUNT]!;
    if (!Number.isInteger(targetCount) || targetCount < 1 || !Number.isInteger(distractorCount) || distractorCount < 0) {
      throw new Error(`${config.seedKey}: wave ${i + 1} has invalid object counts`);
    }
    if (distractorCount > 0) actualCoexistWaveCount += 1;
    if (targetCount + distractorCount === config.sameScreenCap) actualPeakWaveCount += 1;
    if (targetCount + distractorCount > config.sameScreenCap) {
      throw new Error(`${config.seedKey}: wave ${i + 1} exceeds sameScreenCap`);
    }
  }
  if (actualCoexistWaveCount !== config.coexistWaveCount) throw new Error(`${config.seedKey}: coexistWaveCount mismatch`);
  if (actualPeakWaveCount !== config.peakWaveCount) throw new Error(`${config.seedKey}: peakWaveCount mismatch`);

  if (config.waveCount !== WAVE_COUNT || config.roundActiveMs !== OPERATION_DURATION_MS ||
      config.firstWaveMs !== FIRST_WAVE_MS || config.waveSpacingMs !== WAVE_ONSET_INTERVAL_MS ||
      config.enterAnimationMs !== ENTER_ANIMATION_MS || config.exitAnimationMs !== EXIT_ANIMATION_MS ||
      config.hitFeedbackMs !== HIT_FEEDBACK_MS) {
    throw new Error(`${config.seedKey}: fixed timing constants mismatch`);
  }
  const expectedTiming = lifecycleFor(config.timingBand);
  if (config.stimulusLifecycleMs !== expectedTiming.stimulusLifecycleMs ||
      config.activeHoldMs !== expectedTiming.activeHoldMs ||
      config.interWaveBlankMs !== expectedTiming.interWaveBlankMs ||
      config.postLastBufferMs !== expectedTiming.postLastBufferMs) {
    throw new Error(`${config.seedKey}: timing-band tuple mismatch`);
  }
  if (config.enterAnimationMs + config.activeHoldMs + config.exitAnimationMs !== config.stimulusLifecycleMs) {
    throw new Error(`${config.seedKey}: lifecycle components do not sum to stimulusLifecycleMs`);
  }
  if (config.waveSpacingMs - config.stimulusLifecycleMs !== config.interWaveBlankMs) {
    throw new Error(`${config.seedKey}: inter-wave blank does not match wave spacing minus lifecycle`);
  }
  if (config.interWaveBlankMs < config.hitFeedbackMs) {
    throw new Error(`${config.seedKey}: inter-wave blank is shorter than hit feedback`);
  }
  const lastDeadline = config.firstWaveMs + (WAVE_COUNT - 1) * config.waveSpacingMs + config.stimulusLifecycleMs;
  if (lastDeadline + config.postLastBufferMs !== OPERATION_DURATION_MS) {
    throw new Error(`${config.seedKey}: schedule and postLastBufferMs do not close at 30000ms`);
  }

  if (config.similarDistractorCount > config.distractorTotal) throw new Error("similar distractor quota exceeds D");
  if (config.targetFarEdgeCount > config.targetTotal) throw new Error("target far-edge quota exceeds T");
  if (config.distractorFarEdgeCount > config.distractorTotal) throw new Error("distractor far-edge quota exceeds D");
  if (config.doubleTargetCount > config.targetTotal) throw new Error("double target quota exceeds T");
  if (config.doubleTargetCount > WAVE_COUNT) throw new Error("double target quota exceeds one-per-wave limit");
  if (config.doubleTargetCount === 0) {
    if (config.doubleWindowMs !== 0 || config.doublePatternId !== "NONE") throw new Error("non-double level has double configuration");
  } else if (config.level < 102 || config.doubleWindowMs < 1200 || config.doubleWindowMs > 1500 || config.doubleWindowMs % 100 !== 0) {
    throw new Error("double targets are only legal from L102 with a 1200-1500ms window in 100ms steps");
  }

  const expectedScoring = config.distractorTotal === 0
    ? {profile: "SC_NO_DISTRACTOR" as const, upgrade: 0, hold: 0}
    : config.distractorTotal === 5
      ? {profile: "SC_WITH_DISTRACTOR" as const, upgrade: 1, hold: 2}
      : {profile: "SC_WITH_DISTRACTOR" as const, upgrade: 2, hold: 3};
  if (config.scoringProfileId !== expectedScoring.profile ||
      config.upgradeFalseLimit !== expectedScoring.upgrade || config.holdFalseLimit !== expectedScoring.hold) {
    throw new Error(`${config.seedKey}: scoring threshold profile mismatch`);
  }
  if (config.minTargetHits !== Math.ceil(config.targetTotal * 80 / 100)) {
    throw new Error(`${config.seedKey}: minTargetHits is not the minimum integer satisfying the 80% upgrade threshold`);
  }
  const expectedBackgroundId = `BG${String(Math.ceil(config.level / 15)).padStart(2, "0")}`;
  if (config.backgroundId !== expectedBackgroundId) throw new Error(`${config.seedKey}: background chapter mapping mismatch`);
}

export function validateVerticalSliceConfig(config: CatchLightGameConfig): void {
  if (config.schemaVersion !== CATCH_LIGHT_CONFIG_VERSION || config.gameCode !== CATCH_LIGHT_GAME_CODE ||
      config.gameConfigSchemaId !== CATCH_LIGHT_CONFIG_SCHEMA_ID || config.configSetId !== CATCH_LIGHT_CONFIG_SET_ID) {
    throw new Error("config identity mismatch");
  }
  if (config.generatorVersion !== CATCH_LIGHT_GENERATOR_VERSION ||
      config.scoringRuleVersion !== CATCH_LIGHT_SCORING_RULE_VERSION ||
      config.resultSchemaVersion !== CATCH_LIGHT_RESULT_SCHEMA_VERSION) {
    throw new Error("version identity mismatch");
  }
  if (config.sourceWorkbookName !== CATCH_LIGHT_SOURCE_WORKBOOK_NAME ||
      config.sourceWorkbookSha256 !== CATCH_LIGHT_SOURCE_WORKBOOK_SHA256 ||
      config.sourceWorkbookRole !== CATCH_LIGHT_SOURCE_WORKBOOK_ROLE ||
      config.sourceRequirementSha256 !== CATCH_LIGHT_REQUIREMENT_SHA256 ||
      config.publicRulesSha256 !== A620_PUBLIC_RULES_SHA256) {
    throw new Error("source provenance mismatch");
  }
  if (config.durationMs !== SESSION_DURATION_MS || config.plannedBatchCount !== PLANNED_BATCH_COUNT ||
      config.designMaxLevel !== DESIGN_MAX_LEVEL || config.qaSeed !== CATCH_LIGHT_QA_SEED) {
    throw new Error("session identity or timing mismatch");
  }
  if (config.fruitCatalogVersion !== "catch-light-fruit-catalog-1" || config.layoutCatalogVersion !== "catch-light-grid-catalog-1") {
    throw new Error("catalog version mismatch");
  }
  if (config.fruitCatalog.length !== FRUIT_CATALOG.length ||
      config.fruitCatalog.some((fruit, index) => canonicalSha256(fruit) !== canonicalSha256(FRUIT_CATALOG[index]))) {
    throw new Error("fruit catalog differs from the frozen W2 catalog");
  }
  if (canonicalSha256(config.fruitPools) !== canonicalSha256(FRUIT_POOLS)) throw new Error("fruit pools differ from the frozen W2 pools");
  if (canonicalSha256(config.grids) !== canonicalSha256(GRID_CATALOG)) throw new Error("grid catalog differs from the frozen W2 catalog");
  if (canonicalSha256(config.waveProfiles) !== canonicalSha256(WAVE_PROFILES)) throw new Error("wave profiles differ from the frozen W2 profiles");

  const profilesById = new Map<string, WaveProfile>();
  for (const profile of config.waveProfiles) {
    if (profilesById.has(profile.waveProfileId)) throw new Error(`duplicate wave profile ${profile.waveProfileId}`);
    profilesById.set(profile.waveProfileId, profile);
  }
  const seenLevels = new Set<number>();
  const seenVariants = new Set<string>();
  const seenSeeds = new Set<string>();
  for (const item of config.levels) {
    if (seenLevels.has(item.level)) throw new Error(`duplicate level ${item.level}`);
    if (seenVariants.has(item.contentVariantId)) throw new Error(`duplicate contentVariantId ${item.contentVariantId}`);
    if (seenSeeds.has(item.seedKey)) throw new Error(`duplicate seedKey ${item.seedKey}`);
    seenLevels.add(item.level); seenVariants.add(item.contentVariantId); seenSeeds.add(item.seedKey);
    const profile = profilesById.get(item.waveProfileId);
    if (profile === undefined) throw new Error(`unknown waveProfileId: ${item.waveProfileId}`);
    validateLevelConfig(item, profile);
  }
  const actualLevels = [...seenLevels].sort((a, b) => a - b);
  const requiredLevels = [1, 28, 67, 102, 120];
  if (actualLevels.length !== requiredLevels.length || actualLevels.some((value, index) => value !== requiredLevels[index])) {
    throw new Error("W2 config must contain exactly L1/L28/L67/L102/L120");
  }
  for (const grid of config.grids) {
    if (grid.slots.length !== grid.rows * grid.cols) throw new Error(`${grid.gridId}: grid slot count mismatch`);
    for (const slot of grid.slots) {
      if (slot.minHitWidthDp < 56 || slot.minHitHeightDp < 56) {
        throw new Error(`${grid.gridId}/${slot.slotId}: hit area is below the frozen 56dp minimum`);
      }
    }
  }
  if (BATCH_DURATION_MS * PLANNED_BATCH_COUNT !== SESSION_DURATION_MS) throw new Error("batch/session duration invariant failed");
}

export const CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256 = canonicalSha256(CATCH_LIGHT_VERTICAL_SLICE_CONFIG);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseStrictGameConfig(value: Readonly<Record<string, unknown>>): CatchLightGameConfig {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("the Gate 0 empty gameConfig is legacy-vector-only and is rejected by the W2 runtime");
  }
  const parsed = value as unknown as CatchLightGameConfig;
  validateVerticalSliceConfig(parsed);
  if (canonicalSha256(parsed) !== CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256) {
    throw new Error("runtime gameConfig differs from the frozen W2 compiled artifact");
  }
  return parsed;
}

validateVerticalSliceConfig(CATCH_LIGHT_VERTICAL_SLICE_CONFIG);
