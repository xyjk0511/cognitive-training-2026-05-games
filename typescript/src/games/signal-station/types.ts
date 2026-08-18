export type TimingProfileId = "A" | "C" | "H";
export type WaveTemplateId = "P10_D0" | "P15_D5" | "P20_D5" | "P20_D10";
export type TargetCategoryId = "A" | "B";
export type SignalRole = "TARGET" | "DISTRACTOR";
export type Contour = "CIRCLE" | "ROUNDED_SQUARE" | "TRIANGLE" | "DIAMOND" | "HEXAGON" | "SHIELD";
export type InnerMark = "DOT" | "BAR" | "DOUBLE_BAR" | "CROSS" | "CHEVRON" | "ARC";
export type DirectionDeg = 0 | 90 | 180 | 270;
export type ColorFamily = "BLUE" | "TEAL" | "AMBER" | "VIOLET";
export type SimilarityTier = 0 | 1 | 2 | 3;
export type Quadrant = "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT";

export type ObjectState =
  | "SCHEDULED"
  | "ENTERING"
  | "ACTIVE"
  | "WAIT_SECOND"
  | "HIT"
  | "FALSE_TOUCH"
  | "TIMEOUT"
  | "EXITING"
  | "GONE";

export type TouchDisposition =
  | "IGNORED_BLANK"
  | "IGNORED_DUPLICATE_EVENT"
  | "IGNORED_OUTSIDE_WINDOW"
  | "IGNORED_LOCKED"
  | "TARGET_HIT"
  | "DOUBLE_FIRST"
  | "DOUBLE_COMPLETED"
  | "DISTRACTOR_FALSE_TOUCH";

export interface TimingProfile {
  readonly id: TimingProfileId;
  readonly enteringMs: number;
  readonly activeMs: number;
  readonly exitingMs: number;
  readonly lifecycleMs: number;
  readonly gapMs: number;
  readonly tailBufferMs: number;
  readonly doubleWindowMs: number;
}

export interface WaveTemplate {
  readonly id: WaveTemplateId;
  readonly targetCounts: readonly number[];
  readonly distractorCounts: readonly number[];
  readonly targetTotal: number;
  readonly distractorTotal: number;
}

export interface LevelConfig {
  readonly level: number;
  readonly stageId: "S01" | "S02" | "S12" | "S14" | "S15" | "S16";
  readonly gridRows: number;
  readonly gridColumns: number;
  readonly timingProfile: TimingProfileId;
  readonly waveTemplate: WaveTemplateId;
  readonly targetClassCount: 1 | 2;
  readonly targetClassSplit: readonly number[];
  readonly similarityTier: SimilarityTier;
  readonly directionCount: 1 | 2 | 4;
  readonly doubleCount: number;
  readonly doubleWaveOrdinals: readonly number[];
  readonly maxWaveObjects: number;
}

export interface VerticalSliceCoverageBlock {
  readonly reason: "LEVEL_NOT_IMPLEMENTED";
  readonly blockedLevel: number;
  readonly afterBatchOrdinal: number;
}

export interface SignalStationRuntimeConfig {
  readonly schemaVersion: "A620-SS-CONFIG-1.2.1";
  readonly requirementVersion: "1.2.1";
  readonly generatorVersion: "signal-station-gen-1.2.1-r2";
  readonly scoringRuleVersion: "signal-station-score-1.2.1";
  readonly contentVersion: "signal-station-six-slice-1.2.1-r2";
  readonly sourceWorkbookSha256: string;
  readonly requirementDocumentSha256: string;
  readonly publicRulesDocumentSha256: string;
  readonly durationMs: 300000;
  readonly plannedBatchCount: 8;
  readonly batchDurationMs: 37500;
  readonly cueDurationMs: 3000;
  readonly operationDurationMs: 30000;
  readonly feedbackDurationMs: 2000;
  readonly transitionDurationMs: 2500;
  readonly waveStartOffsetsMs: readonly number[];
  readonly timingProfiles: Readonly<Record<TimingProfileId, TimingProfile>>;
  readonly levelConfigs: Readonly<Record<string, LevelConfig>>;
  readonly fullLevelSetStatus: "HOLD";
}

export interface SignalSymbol {
  readonly contour: Contour;
  readonly innerMark: InnerMark;
  readonly directionDeg: DirectionDeg;
  readonly colorFamily: ColorFamily;
}

export interface GeneratedSignalInstance {
  readonly instanceId: string;
  readonly batchOrdinal: number;
  readonly waveOrdinal: number;
  readonly role: SignalRole;
  readonly targetCategoryId: TargetCategoryId | null;
  readonly similarityReferenceTargetCategoryId: TargetCategoryId | null;
  readonly requiresDouble: boolean;
  readonly slotIndex: number;
  readonly row: number;
  readonly column: number;
  readonly quadrant: Quadrant;
  readonly symbol: SignalSymbol;
  readonly enterStartInBatchMs: number;
  readonly naturalExitEndInBatchMs: number;
}

export interface GeneratedWave {
  readonly waveOrdinal: number;
  readonly startOffsetInOperationMs: number;
  readonly instances: readonly GeneratedSignalInstance[];
}

export interface GeneratedBatchPlan {
  readonly generatorVersion: string;
  readonly sessionSeed: number;
  readonly level: number;
  readonly batchOrdinal: number;
  readonly targetCards: Readonly<Record<TargetCategoryId, SignalSymbol | null>>;
  readonly waves: readonly GeneratedWave[];
  readonly targetTotal: number;
  readonly distractorTotal: number;
  readonly doubleTotal: number;
}

export interface TouchResult {
  readonly disposition: TouchDisposition;
  readonly instanceId: string | null;
  readonly stateAfter: ObjectState | null;
  readonly hitDelta: 0 | 1;
  readonly falseTouchDelta: 0 | 1;
}

export interface ReactionSummary {
  readonly count: number;
  readonly totalMs: number;
  readonly minMs: number | null;
  readonly maxMs: number | null;
}

export interface BatchMetrics {
  readonly H: number;
  readonly T: number;
  readonly F: number;
  readonly D: number;
  readonly timingProfile: TimingProfileId;
  readonly targetClassCount: 1 | 2;
  readonly similarityTier: SimilarityTier;
  readonly directionCount: 1 | 2 | 4;
  readonly doubleCount: number;
  readonly completedDoubleCount: number;
  readonly timedOutDoubleCount: number;
  readonly presentedWaveCount: 8;
  readonly reactionTimeCount: number;
  readonly reactionTimeTotalMs: number;
  readonly reactionTimeMinMs: number | null;
  readonly reactionTimeMaxMs: number | null;
  readonly doubleIntervalCount: number;
  readonly doubleIntervalTotalMs: number;
}

export interface PartialMetrics {
  readonly waveOrdinal: number;
  readonly presentedTargetCount: number;
  readonly presentedDistractorCount: number;
  readonly H: number;
  readonly F: number;
  readonly waitingDoubleCount: number;
  readonly completedDoubleCount: number;
  readonly timedOutTargetCount: number;
  readonly activeElapsedInBatchMs: number;
}

export type ResultZone = "UPGRADE" | "HOLD" | "FAIL";
export type LevelTransition = "UP" | "HOLD" | "RETRY" | "DOWN" | "HOLD_MAX" | "HOLD_MIN";

export interface ScoreDecision {
  readonly resultZone: ResultZone;
  readonly batchScore: number;
}

export interface LevelDecision {
  readonly levelTransition: LevelTransition;
  readonly levelAfter: number;
  readonly consecutiveFailCountAfter: 0 | 1;
}
