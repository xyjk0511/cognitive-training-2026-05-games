import type { EligibleBatch, GameResultDraft, IncompleteBatchAudit } from "../../contracts.js";

export const CATCH_LIGHT_GAME_CODE = "CATCH_LIGHT" as const;
export const CATCH_LIGHT_CONFIG_VERSION = "1.5.0" as const;
export const CATCH_LIGHT_GENERATOR_VERSION = "catch-light-gen-2" as const;
export const CATCH_LIGHT_SCORING_RULE_VERSION = "1.5.0" as const;
export const CATCH_LIGHT_RESULT_SCHEMA_VERSION = "A620-TRR-1.1" as const;
export const CATCH_LIGHT_CONFIG_SCHEMA_ID = "urn:a620:catch-light:config:1.5" as const;
export const CATCH_LIGHT_CONFIG_SET_ID = "catch-light-v1.5-w2-vertical-slices-r2" as const;
export const CATCH_LIGHT_QA_SEED = 20260817 as const;
export const CATCH_LIGHT_RUNTIME_SLICE_LEVELS = [1, 28, 102, 120] as const;
export const CATCH_LIGHT_GOLDEN_ANCHOR_LEVELS = [1, 28, 67, 102, 120] as const;
export const CATCH_LIGHT_SOURCE_WORKBOOK_NAME = "捕光行动-120级数值设计-v1.4.xlsx" as const;
export const CATCH_LIGHT_SOURCE_WORKBOOK_SHA256 = "592a6313bb3f308aa63d5e1313db98b617dfc735ac8fd61efb7c7f06112d716d" as const;
export const CATCH_LIGHT_SOURCE_WORKBOOK_ROLE = "HISTORICAL_NUMERIC_INPUT_ONLY" as const;
export const CATCH_LIGHT_REQUIREMENT_SHA256 = "1ff1d38470aead2270d6b237b3cda2a21a7540174420252a5bda8b242bfb425c" as const;
export const A620_PUBLIC_RULES_SHA256 = "c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794" as const;

export const SESSION_DURATION_MS = 300000 as const;
export const PLANNED_BATCH_COUNT = 8 as const;
export const BATCH_DURATION_MS = 37500 as const;
export const PROMPT_DURATION_MS = 3000 as const;
export const OPERATION_DURATION_MS = 30000 as const;
export const FEEDBACK_DURATION_MS = 2000 as const;
export const TRANSITION_DURATION_MS = 2500 as const;
export const WAVE_COUNT = 8 as const;
export const FIRST_WAVE_MS = 500 as const;
export const WAVE_ONSET_INTERVAL_MS = 3650 as const;
export const ENTER_ANIMATION_MS = 200 as const;
export const EXIT_ANIMATION_MS = 200 as const;
export const HIT_FEEDBACK_MS = 300 as const;
export const DESIGN_MAX_LEVEL = 120 as const;

export const FRUIT_IDS = [
  "APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE",
  "WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO",
] as const;
export type FruitId = typeof FRUIT_IDS[number];
export type FruitPoolId = "FP_CORE_A" | "FP_CORE_B" | "FP_TRANSFER";
export type TimingBand = "A" | "C" | "H";
export type GridId = "2x2" | "2x3" | "3x3" | "3x4";
export type ObjectRole = "TARGET" | "DISTRACTOR";
export type SimilarityClass = "TARGET" | "SIMILAR" | "CLEAR";
export type DoublePatternId = "NONE" | "MAX2_CONSEC" | "MAX3_CONSEC";
export type RuleIntroFlag = "FULL_RULE" | "DISTRACTOR_RULE" | "NONE" | "DOUBLE_RULE";

export interface FruitDefinition {
  fruitId: FruitId;
  displayNameZh: string;
  assetPath: string;
  mainColorHex: string;
  outlineShape: string;
  textureCue: string;
  targetAllowed: true;
  distractorAllowed: true;
  similarityTags: readonly string[];
}

export type FruitSimilarityAuthority =
  | "SOURCE_WORKBOOK_CONFIRMED"
  | "ENGINEERING_COMPATIBILITY_UNAPPROVED";

export type FruitSimilarityAttribute = "COLOR" | "SHAPE" | "TEXTURE";

export interface FruitSimilarityRelation {
  tag: string;
  fruitA: FruitId;
  fruitB: FruitId;
  primaryAttribute: FruitSimilarityAttribute;
  authority: FruitSimilarityAuthority;
}

export interface QualifiedFruitSimilarityPair {
  tag: string;
  fruitA: FruitId;
  fruitB: FruitId;
  primaryAttribute: FruitSimilarityAttribute;
}

export interface FruitSimilarityQualificationGroup {
  relationStatus: FruitSimilarityAuthority;
  source: string;
  relationUseApproved: boolean;
  productionGate: "NONE" | "BLOCK_UNTIL_PRODUCT_AND_ART_APPROVE_FINAL_SPRITES_AND_PAIR_MATRIX";
  pairs: readonly QualifiedFruitSimilarityPair[];
}

export interface FruitContentQualification {
  qualificationVersion: "catch-light-fruit-content-qualification-1";
  runtimeUseStatus: "HEADLESS_VERTICAL_SLICE_ONLY";
  productionActivationStatus: "BLOCKED_PENDING_FRUIT_SPRITES_AND_CORE_B_RELATION_APPROVAL";
  fruitMetadataStatus: "ENGINEERING_PLACEHOLDER_PENDING_ART_QA";
  fruitSpriteStatus: "PLACEHOLDER_REFERENCES_ONLY";
  coreA: FruitSimilarityQualificationGroup;
  coreB: FruitSimilarityQualificationGroup;
}

export interface GridSlot {
  slotId: string;
  row: number;
  col: number;
  xBasisPoints: number;
  yBasisPoints: number;
  edgeSlot: boolean;
  minHitWidthDp: number;
  minHitHeightDp: number;
}

export interface GridDefinition {
  gridId: GridId;
  rows: number;
  cols: number;
  slots: readonly GridSlot[];
}

export interface WaveProfile {
  waveProfileId: string;
  targetsByWave: readonly number[];
  distractorsByWave: readonly number[];
}

export interface CatchLightLevelConfig {
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
  waveCount: typeof WAVE_COUNT;
  roundActiveMs: typeof OPERATION_DURATION_MS;
  firstWaveMs: typeof FIRST_WAVE_MS;
  waveSpacingMs: typeof WAVE_ONSET_INTERVAL_MS;
  stimulusLifecycleMs: number;
  enterAnimationMs: typeof ENTER_ANIMATION_MS;
  activeHoldMs: number;
  exitAnimationMs: typeof EXIT_ANIMATION_MS;
  interWaveBlankMs: number;
  postLastBufferMs: number;
  hitFeedbackMs: typeof HIT_FEEDBACK_MS;
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
  doublePatternId: DoublePatternId;
  firstTeachingBatchWaveOneDoubleDisabled: boolean;
  minTargetHits: number;
  upgradeFalseLimit: number;
  holdFalseLimit: number;
  scoringProfileId: "SC_NO_DISTRACTOR" | "SC_WITH_DISTRACTOR";
  layoutPoolId: string;
  seedKey: string;
  ruleIntroFlag: RuleIntroFlag;
  backgroundLockRule: "HIGHEST_UNLOCKED_CHAPTER_SESSION_LOCK";
  interactionProfileId: "CL_CHILD_V1";
}

export interface CatchLightGameConfig {
  schemaVersion: typeof CATCH_LIGHT_CONFIG_VERSION;
  gameCode: typeof CATCH_LIGHT_GAME_CODE;
  gameConfigSchemaId: typeof CATCH_LIGHT_CONFIG_SCHEMA_ID;
  generatorVersion: typeof CATCH_LIGHT_GENERATOR_VERSION;
  scoringRuleVersion: typeof CATCH_LIGHT_SCORING_RULE_VERSION;
  resultSchemaVersion: typeof CATCH_LIGHT_RESULT_SCHEMA_VERSION;
  durationMs: typeof SESSION_DURATION_MS;
  plannedBatchCount: typeof PLANNED_BATCH_COUNT;
  designMaxLevel: typeof DESIGN_MAX_LEVEL;
  qaSeed: typeof CATCH_LIGHT_QA_SEED;
  configSetId: typeof CATCH_LIGHT_CONFIG_SET_ID;
  sourceWorkbookName: typeof CATCH_LIGHT_SOURCE_WORKBOOK_NAME;
  sourceWorkbookSha256: typeof CATCH_LIGHT_SOURCE_WORKBOOK_SHA256;
  sourceWorkbookRole: typeof CATCH_LIGHT_SOURCE_WORKBOOK_ROLE;
  sourceRequirementSha256: typeof CATCH_LIGHT_REQUIREMENT_SHA256;
  publicRulesSha256: typeof A620_PUBLIC_RULES_SHA256;
  fruitCatalogVersion: "catch-light-fruit-catalog-2";
  fruitSimilarityCatalogVersion: "catch-light-fruit-similarity-2";
  layoutCatalogVersion: "catch-light-grid-catalog-1";
  fruitCatalog: readonly FruitDefinition[];
  fruitSimilarityRelations: readonly FruitSimilarityRelation[];
  fruitContentQualification: FruitContentQualification;
  fruitPools: Readonly<Record<FruitPoolId, readonly FruitId[]>>;
  grids: readonly GridDefinition[];
  waveProfiles: readonly WaveProfile[];
  levels: readonly CatchLightLevelConfig[];
}

export interface GeneratedInstance {
  instanceId: string;
  waveOrdinal: number;
  ordinalInWave: number;
  role: ObjectRole;
  fruitId: FruitId;
  similarityClass: SimilarityClass;
  slotId: string;
  edgeEmphasis: boolean;
  isDouble: boolean;
  activeStartMs: number;
  activeDeadlineMs: number;
  enterEndMs: number;
  exitStartMs: number;
  doubleWindowMs: number;
}

export interface GeneratedWave {
  waveOrdinal: number;
  seedMaterial: string;
  seed32: number;
  onsetMs: number;
  targetCount: number;
  distractorCount: number;
  instances: readonly GeneratedInstance[];
}

export interface GeneratedBatchSchedule {
  generatorVersion: typeof CATCH_LIGHT_GENERATOR_VERSION;
  configSetId: typeof CATCH_LIGHT_CONFIG_SET_ID;
  level: number;
  batchOrdinal: number;
  sessionSeed: number;
  seedKey: string;
  batchPlanSeedMaterial: string;
  batchPlanSeed32: number;
  targetFruitId: FruitId;
  backgroundId: string;
  gridId: GridId;
  targetTotal: number;
  distractorTotal: number;
  sameScreenCap: number;
  firstTeachingBatchWaveOneDoubleSuppressed: boolean;
  waves: readonly GeneratedWave[];
  scheduleSha256: string;
}

export type FruitInteractionState =
  | "SCHEDULED"
  | "ENTERING"
  | "ACTIVE"
  | "ACTIVE_FIRST"
  | "WAIT_SECOND"
  | "HIT"
  | "COMPLETED"
  | "FALSE_TOUCH"
  | "TIMEOUT"
  | "EXITING"
  | "GONE";

export type FruitVisualPhase = "HIDDEN" | "ENTERING" | "ACTIVE" | "EXITING" | "FEEDBACK" | "GONE";
export type CatchLightBatchPhase = "PROMPT" | "OPERATION" | "FEEDBACK" | "TRANSITION" | "CLOSED";

export interface FruitPresentationSnapshot {
  instanceId: string;
  waveOrdinal: number;
  role: ObjectRole;
  fruitId: FruitId;
  slotId: string;
  isDouble: boolean;
  visualPhase: FruitVisualPhase;
  interactionState: FruitInteractionState;
  clickable: boolean;
  doubleProgress: 0 | 1 | 2;
  secondDeadlineOperationMs: number | null;
}

export interface CatchLightBatchSnapshot {
  batchOrdinal: number;
  levelBefore: number;
  batchStartActiveMs: number;
  phase: CatchLightBatchPhase;
  operationElapsedMs: number;
  currentWaveOrdinal: number;
  targetFruitId: FruitId;
  backgroundId: string;
  gridId: GridId;
  H: number;
  F: number;
  visibleObjects: readonly FruitPresentationSnapshot[];
}

export interface CatchLightSessionSnapshot {
  activeElapsedMs: number;
  sessionStartLevel: number;
  currentLevel: number;
  backgroundId: string;
  deadlineReached: boolean;
  eligibleBatchCount: number;
  sessionRawScore: number;
  nextBatchOrdinal: number;
  consecutiveFail: 0 | 1;
  pendingBatchNotificationCount: number;
  pendingBatchNotificationHashes: readonly string[];
  currentBatch: CatchLightBatchSnapshot | null;
}

/**
 * Read-only inspection surface used by the headless harness and rendering
 * integration. It deliberately excludes the mutable batch runtime so callers
 * cannot close, seal or advance the session's internal batch out of band.
 */
export interface CatchLightCurrentBatchView {
  batchOrdinal: number;
  levelBefore: number;
  batchStartActiveMs: number;
  operationStartActiveMs: number;
  operationEndActiveMs: number;
  closeAtActiveMs: number;
  levelConfig: CatchLightLevelConfig;
  schedule: GeneratedBatchSchedule;
}

export type TouchDisposition =
  | "TARGET_HIT"
  | "DISTRACTOR_FALSE_TOUCH"
  | "DOUBLE_FIRST"
  | "DOUBLE_COMPLETED"
  | "IGNORED_BEFORE_WINDOW"
  | "IGNORED_AT_OR_AFTER_DEADLINE"
  | "IGNORED_SAME_TIMESTAMP"
  | "IGNORED_ALREADY_SETTLED"
  | "IGNORED_WRONG_INSTANCE_PHASE";

export interface TouchResult {
  disposition: TouchDisposition;
  changedStatistics: boolean;
  hitDelta: 0 | 1;
  falseTouchDelta: 0 | 1;
}

export interface InstanceAudit {
  instanceId: string;
  fruitId: FruitId;
  role: ObjectRole;
  slotId: string;
  isDouble: boolean;
  firstTouchActiveMs: number | null;
  secondTouchActiveMs: number | null;
  outcome: "HIT" | "FALSE_TOUCH" | "TIMEOUT" | "AVOIDED" | "UNRESOLVED";
}

export interface BatchMetrics extends Record<string, unknown> {
  metricsVersion: "catch-light-batch-metrics-2";
  H: number;
  T: number;
  F: number;
  D: number;
  targetFruitId: FruitId;
  backgroundId: string;
  configSetId: typeof CATCH_LIGHT_CONFIG_SET_ID;
  generatorVersion: typeof CATCH_LIGHT_GENERATOR_VERSION;
  difficultyStateId: string;
  timingProfile: TimingBand;
  contentVariantId: string;
  waveProfileId: string;
  seedKey: string;
  scheduleSha256: string;
  firstTeachingBatchWaveOneDoubleSuppressed: boolean;
  instanceAuditSha256: string;
  targetTimeouts: number;
  distractorAvoided: number;
  doubleTargets: number;
  doubleCompleted: number;
  doubleFirstOnly: number;
  totalObjectTouches: number;
  blankTouches: number;
  duplicateTouches: number;
  consecutiveFailBefore: 0 | 1;
  consecutiveFailAfter: 0 | 1;
}

export interface PartialBatchMetrics extends Record<string, unknown> {
  metricsVersion: "catch-light-partial-metrics-2";
  phase: "PROMPT" | "OPERATION" | "FEEDBACK" | "TRANSITION";
  waveOrdinal: number;
  presentedTargetCount: number;
  presentedDistractorCount: number;
  H: number;
  F: number;
  unresolvedTargetCount: number;
  totalObjectTouches: number;
  blankTouches: number;
  duplicateTouches: number;
  scheduleSha256: string;
  firstTeachingBatchWaveOneDoubleSuppressed: boolean;
  instanceAuditSha256: string;
}

export interface SessionMetrics extends Record<string, unknown> {
  metricsVersion: "catch-light-session-metrics-1";
  passEngineType: "PE-EVENT";
  configSetId: typeof CATCH_LIGHT_CONFIG_SET_ID;
  generatorVersion: typeof CATCH_LIGHT_GENERATOR_VERSION;
  scoringRuleVersion: typeof CATCH_LIGHT_SCORING_RULE_VERSION;
  resultSchemaVersion: typeof CATCH_LIGHT_RESULT_SCHEMA_VERSION;
  sessionSeed: number;
  backgroundId: string;
  pauseCount: number;
  totalPausedDurationMs: number;
  eligibleBatchCount: number;
  incompleteBatchCount: number;
  H: number;
  T: number;
  F: number;
  D: number;
  eligibleTargetInstances: number;
  eligibleTargetHits: number;
  eligibleDistractorInstances: number;
  eligibleDistractorFalseTouches: number;
  eligibleDoubleTargets: number;
  eligibleDoubleCompleted: number;
  totalObjectTouches: number;
  blankTouches: number;
  duplicateTouches: number;
  hitRateBasisPoints: number | null;
  distractorAvoidanceBasisPoints: number | null;
  scheduleAuditSha256: string;
}

export type CatchLightEligibleBatch = Omit<EligibleBatch, "gameBatchMetrics"> & { gameBatchMetrics: BatchMetrics };
export type CatchLightIncompleteBatchAudit = Omit<IncompleteBatchAudit, "partialMetrics"> & { partialMetrics: PartialBatchMetrics };
export type CatchLightGameResultDraft = Omit<GameResultDraft, "eligibleBatches" | "incompleteBatchAudit" | "gameMetrics"> & {
  eligibleBatches: CatchLightEligibleBatch[];
  incompleteBatchAudit: CatchLightIncompleteBatchAudit[];
  gameMetrics: SessionMetrics;
};

export interface LevelDecision {
  resultZone: "UPGRADE" | "HOLD" | "FAIL";
  levelTransition: "UP" | "HOLD" | "RETRY" | "DOWN" | "HOLD_MAX" | "HOLD_MIN";
  levelAfter: number;
  consecutiveFailAfter: 0 | 1;
}
