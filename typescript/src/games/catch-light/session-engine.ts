import { canonicalSha256 } from "../../canonical.js";
import { CatchLightBatchRuntime } from "./batch-engine.js";
import { validateVerticalSliceConfig } from "./config.js";
import { generateBatchSchedule } from "./generator.js";
import {
  CATCH_LIGHT_RESULT_SCHEMA_VERSION,
  CATCH_LIGHT_RUNTIME_SLICE_LEVELS,
  CATCH_LIGHT_SCORING_RULE_VERSION,
  DESIGN_MAX_LEVEL,
  PLANNED_BATCH_COUNT,
  SESSION_DURATION_MS,
  type CatchLightEligibleBatch,
  type CatchLightGameConfig,
  type CatchLightGameResultDraft,
  type CatchLightIncompleteBatchAudit,
  type CatchLightLevelConfig,
  type SessionMetrics,
  type TouchResult,
} from "./types.js";

export interface CatchLightSessionOptions {
  gameConfig: CatchLightGameConfig;
  runtimeConfigHash: string;
  sessionSeed: number;
  sessionStartLevel: number;
  batchStartDelaysMs?: readonly number[];
  onBatchClosed?: (batch: CatchLightEligibleBatch) => void;
}

export class CatchLightSession {
  private readonly gameConfig: CatchLightGameConfig;
  private readonly configByLevel: Map<number, CatchLightLevelConfig>;
  private readonly runtimeConfigHash: string;
  private readonly sessionSeed: number;
  private readonly sessionStartLevel: number;
  private readonly sessionBackgroundId: string;
  private readonly batchStartDelaysMs: readonly number[];
  private readonly onBatchClosed: ((batch: CatchLightEligibleBatch) => void) | undefined;
  private readonly eligibleBatches: CatchLightEligibleBatch[] = [];
  private currentBatch: CatchLightBatchRuntime | null = null;
  private nextBatchOrdinal = 1;
  private nextBatchStartActiveMs: number;
  private currentLevel: number;
  private consecutiveFail: 0 | 1 = 0;
  private latestActiveMs = 0;
  private pauseCount = 0;
  private totalPausedDurationMs = 0;
  private deadlineReached = false;
  private incompleteAudit: CatchLightIncompleteBatchAudit[] = [];

  constructor(options: CatchLightSessionOptions) {
    validateVerticalSliceConfig(options.gameConfig);
    if (!/^[0-9a-f]{64}$/.test(options.runtimeConfigHash)) throw new Error("runtimeConfigHash must be lowercase SHA-256");
    if (!Number.isSafeInteger(options.sessionSeed) || options.sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
    this.gameConfig = options.gameConfig;
    this.configByLevel = new Map(options.gameConfig.levels.map(config => [config.level, config]));
    this.runtimeConfigHash = options.runtimeConfigHash;
    this.sessionSeed = options.sessionSeed;
    if (!(CATCH_LIGHT_RUNTIME_SLICE_LEVELS as readonly number[]).includes(options.sessionStartLevel)) {
      throw new Error(`sessionStartLevel ${options.sessionStartLevel} is not one of the released W2 runtime slices`);
    }
    this.sessionStartLevel = options.sessionStartLevel;
    this.currentLevel = options.sessionStartLevel;
    this.sessionBackgroundId = this.requireLevelConfig(options.sessionStartLevel).backgroundId;
    this.batchStartDelaysMs = options.batchStartDelaysMs ?? [];
    if (this.batchStartDelaysMs.length > PLANNED_BATCH_COUNT) throw new Error("too many batch start delays");
    for (const delay of this.batchStartDelaysMs) {
      if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("batch start delays must be non-negative safe integers");
    }
    this.nextBatchStartActiveMs = this.delayForOrdinal(1);
    this.onBatchClosed = options.onBatchClosed;
  }

  get currentBatchRuntime(): CatchLightBatchRuntime | null { return this.currentBatch; }
  get closedBatches(): readonly CatchLightEligibleBatch[] { return this.eligibleBatches; }
  get activeElapsedMs(): number { return this.latestActiveMs; }

  recordPauseInterval(pausedDurationMs: number): void {
    if (this.deadlineReached) throw new Error("cannot record pause after deadline");
    if (!Number.isSafeInteger(pausedDurationMs) || pausedDurationMs < 0) {
      throw new Error("pausedDurationMs must be a non-negative safe integer");
    }
    const nextTotal = this.totalPausedDurationMs + pausedDurationMs;
    if (!Number.isSafeInteger(nextTotal)) throw new Error("total paused duration exceeds safe integer range");
    this.pauseCount += 1;
    this.totalPausedDurationMs = nextTotal;
  }

  advanceToActive(activeMs: number): void {
    if (!Number.isSafeInteger(activeMs) || activeMs < 0 || activeMs > SESSION_DURATION_MS) throw new Error("activeMs outside 0..300000");
    if (activeMs < this.latestActiveMs) throw new Error("session active time moved backwards");
    if (this.deadlineReached && activeMs !== SESSION_DURATION_MS) throw new Error("cannot advance after deadline");
    this.latestActiveMs = activeMs;

    while (true) {
      if (this.currentBatch === null) {
        if (this.nextBatchOrdinal > PLANNED_BATCH_COUNT || this.nextBatchStartActiveMs >= SESSION_DURATION_MS || activeMs < this.nextBatchStartActiveMs) break;
        const level = this.requireLevelConfig(this.currentLevel);
        const schedule = generateBatchSchedule(level, this.sessionSeed, this.nextBatchOrdinal, this.sessionBackgroundId);
        this.currentBatch = new CatchLightBatchRuntime({
          batchOrdinal: this.nextBatchOrdinal,
          batchStartActiveMs: this.nextBatchStartActiveMs,
          levelBefore: this.currentLevel,
          consecutiveFailBefore: this.consecutiveFail,
          levelConfig: level,
          schedule,
        });
      }

      const batch = this.currentBatch;
      if (activeMs >= batch.closeAtActiveMs && batch.closeAtActiveMs <= SESSION_DURATION_MS) {
        const closed = batch.close(batch.closeAtActiveMs);
        this.eligibleBatches.push(closed);
        this.currentLevel = closed.levelAfter;
        this.consecutiveFail = closed.gameBatchMetrics.consecutiveFailAfter;
        if (this.onBatchClosed !== undefined) this.onBatchClosed(closed);
        this.currentBatch = null;
        this.nextBatchOrdinal += 1;
        this.nextBatchStartActiveMs = closed.closedAtActiveMs + this.delayForOrdinal(this.nextBatchOrdinal);
        continue;
      }
      batch.advanceToSessionActive(activeMs);
      break;
    }
  }

  touchInstance(instanceId: string, activeMs: number): TouchResult {
    this.advanceToActive(activeMs);
    if (activeMs >= SESSION_DURATION_MS || this.deadlineReached || this.currentBatch === null) {
      return {disposition:"IGNORED_WRONG_INSTANCE_PHASE", changedStatistics:false, hitDelta:0, falseTouchDelta:0};
    }
    return this.currentBatch.touchInstance(instanceId, activeMs);
  }

  touchBlank(activeMs: number): void {
    this.advanceToActive(activeMs);
    if (activeMs < SESSION_DURATION_MS && !this.deadlineReached && this.currentBatch !== null) this.currentBatch.touchBlank(activeMs);
  }

  deadline(): void {
    if (this.deadlineReached) return;
    this.advanceToActive(SESSION_DURATION_MS);
    if (this.currentBatch !== null && !this.currentBatch.isClosed) {
      this.incompleteAudit = [{
        batchOrdinal: this.currentBatch.batchOrdinal,
        levelBefore: this.currentBatch.levelBefore,
        cutoffReason: "DEADLINE",
        startedAtActiveMs: this.currentBatch.batchStartActiveMs,
        cutoffAtActiveMs: SESSION_DURATION_MS,
        partialMetrics: this.currentBatch.partialMetricsAt(SESSION_DURATION_MS),
      }];
    }
    this.deadlineReached = true;
  }

  buildResultDraft(): CatchLightGameResultDraft {
    if (!this.deadlineReached) throw new Error("result draft is unavailable before the 300000ms deadline");
    const eligible = [...this.eligibleBatches];
    const incomplete = [...this.incompleteAudit];
    const presentedLevels = [this.sessionStartLevel, ...eligible.map(batch => batch.levelBefore), ...incomplete.map(audit => audit.levelBefore)];
    const passedLevels = eligible.filter(batch => batch.resultZone === "UPGRADE").map(batch => batch.levelBefore);
    const eligibleMetrics = eligible.map(batch => batch.gameBatchMetrics);
    const currentPartial = this.currentBatch === null ? null : this.currentBatch.partialMetricsAt(SESSION_DURATION_MS);
    const totalObjectTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.totalObjectTouches, 0)
      + (currentPartial?.totalObjectTouches ?? 0);
    const blankTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.blankTouches, 0)
      + (currentPartial?.blankTouches ?? 0);
    const duplicateTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.duplicateTouches, 0)
      + (this.currentBatch?.duplicateTouchCount ?? 0);
    const targetInstances = eligibleMetrics.reduce((sum, metrics) => sum + metrics.T, 0);
    const targetHits = eligibleMetrics.reduce((sum, metrics) => sum + metrics.H, 0);
    const distractorInstances = eligibleMetrics.reduce((sum, metrics) => sum + metrics.D, 0);
    const falseTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.F, 0);
    const sessionMetrics: SessionMetrics = {
      metricsVersion: "catch-light-session-metrics-1",
      passEngineType: "PE-EVENT",
      configSetId: this.gameConfig.configSetId,
      generatorVersion: this.gameConfig.generatorVersion,
      scoringRuleVersion: CATCH_LIGHT_SCORING_RULE_VERSION,
      resultSchemaVersion: CATCH_LIGHT_RESULT_SCHEMA_VERSION,
      sessionSeed: this.sessionSeed,
      backgroundId: this.sessionBackgroundId,
      pauseCount: this.pauseCount,
      totalPausedDurationMs: this.totalPausedDurationMs,
      eligibleBatchCount: eligible.length,
      incompleteBatchCount: incomplete.length,
      H: targetHits,
      T: targetInstances,
      F: falseTouches,
      D: distractorInstances,
      eligibleTargetInstances: targetInstances,
      eligibleTargetHits: targetHits,
      eligibleDistractorInstances: distractorInstances,
      eligibleDistractorFalseTouches: falseTouches,
      eligibleDoubleTargets: eligibleMetrics.reduce((sum, metrics) => sum + metrics.doubleTargets, 0),
      eligibleDoubleCompleted: eligibleMetrics.reduce((sum, metrics) => sum + metrics.doubleCompleted, 0),
      totalObjectTouches,
      blankTouches,
      duplicateTouches,
      hitRateBasisPoints: targetInstances === 0 ? null : Math.floor((targetHits * 10000) / targetInstances),
      distractorAvoidanceBasisPoints: distractorInstances === 0 ? null : Math.floor(((distractorInstances - falseTouches) * 10000) / distractorInstances),
      scheduleAuditSha256: canonicalSha256({
        eligible: eligibleMetrics.map(metrics => metrics.scheduleSha256),
        incomplete: incomplete.map(audit => audit.partialMetrics.scheduleSha256),
      }),
    };
    return {
      gameCode: "CATCH_LIGHT",
      gamePayloadVersion: "A620-GP-1.1",
      runtimeConfigHash: this.runtimeConfigHash,
      designMaxLevel: DESIGN_MAX_LEVEL,
      plannedBatchCount: PLANNED_BATCH_COUNT,
      eligibleBatchCount: eligible.length,
      eligibleBatches: eligible,
      incompleteBatchAudit: incomplete,
      sessionStartLevel: this.sessionStartLevel,
      sessionEndLevel: this.currentLevel,
      sessionHighestPresentedLevel: Math.max(...presentedLevels),
      sessionHighestPassedLevel: passedLevels.length === 0 ? null : Math.max(...passedLevels),
      nextStartLevel: this.currentLevel,
      sessionRawScore: eligible.reduce((sum, batch) => sum + batch.batchScore, 0),
      sessionRawScoreMax: PLANNED_BATCH_COUNT * 100,
      actualTrainingMs: SESSION_DURATION_MS,
      gameMetrics: sessionMetrics,
    };
  }

  private delayForOrdinal(ordinal: number): number {
    if (ordinal < 1 || ordinal > PLANNED_BATCH_COUNT) return 0;
    return this.batchStartDelaysMs[ordinal - 1] ?? 0;
  }

  private requireLevelConfig(level: number): CatchLightLevelConfig {
    const config = this.configByLevel.get(level);
    if (config === undefined) throw new Error(`level ${level} is absent from W2 vertical slices; refusing implicit fallback`);
    return config;
  }
}
