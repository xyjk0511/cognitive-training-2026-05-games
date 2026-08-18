import { canonicalSha256 } from "../../canonical.js";
import { CatchLightBatchRuntime } from "./batch-engine.js";
import { validateVerticalSliceConfig } from "./config.js";
import { generateBatchSchedule } from "./generator.js";
import { immutableSnapshot } from "./immutability.js";
import {
  CATCH_LIGHT_RESULT_SCHEMA_VERSION,
  CATCH_LIGHT_RUNTIME_SLICE_LEVELS,
  CATCH_LIGHT_SCORING_RULE_VERSION,
  DESIGN_MAX_LEVEL,
  PLANNED_BATCH_COUNT,
  SESSION_DURATION_MS,
  type CatchLightEligibleBatch,
  type CatchLightCurrentBatchView,
  type CatchLightGameConfig,
  type CatchLightGameResultDraft,
  type CatchLightIncompleteBatchAudit,
  type CatchLightLevelConfig,
  type CatchLightSessionSnapshot,
  type SessionMetrics,
  type TouchResult,
} from "./types.js";

export interface CatchLightSessionOptions {
  gameConfig: CatchLightGameConfig;
  runtimeConfigHash: string;
  sessionSeed: number;
  sessionStartLevel: number;
  batchStartDelaysMs?: readonly number[];
  /**
   * Levels whose rule-introduction flow was already completed in an earlier
   * attempt/session. This is game-private host context, not a public wire field.
   */
  previouslyIntroducedLevels?: readonly number[];
  onBatchClosed?: (batch: CatchLightEligibleBatch) => void;
}

export class UnsupportedSliceTransitionError extends Error {
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly batchOrdinal: number;

  constructor(fromLevel: number, toLevel: number, batchOrdinal: number) {
    super(`W2 released slices cannot start B${batchOrdinal} after L${fromLevel}->L${toLevel}; implicit nearest-level fallback is forbidden`);
    this.name = "UnsupportedSliceTransitionError";
    this.fromLevel = fromLevel;
    this.toLevel = toLevel;
    this.batchOrdinal = batchOrdinal;
  }
}

const IGNORED_INPUT: TouchResult = Object.freeze({
  disposition: "IGNORED_WRONG_INSTANCE_PHASE",
  changedStatistics: false,
  hitDelta: 0,
  falseTouchDelta: 0,
});

/**
 * Pure active-time session engine. Batch state is committed before an external
 * BATCH_CLOSED callback is attempted. A failed callback therefore leaves one
 * immutable, hash-addressable notification pending for explicit retry instead
 * of replaying scoring or closing the same batch twice.
 */
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
  private readonly pendingBatchNotifications: CatchLightEligibleBatch[] = [];
  private readonly introducedLevels: Set<number>;
  private flushingBatchNotifications = false;
  private currentBatch: CatchLightBatchRuntime | null = null;
  private nextBatchOrdinal = 1;
  private nextBatchStartActiveMs: number;
  private currentLevel: number;
  private consecutiveFail: 0 | 1 = 0;
  private latestActiveMs = 0;
  private pauseCount = 0;
  private totalPausedDurationMs = 0;
  private deadlineReached = false;
  private incompleteAudit: readonly CatchLightIncompleteBatchAudit[] = Object.freeze([]);

  constructor(options: CatchLightSessionOptions) {
    const detachedConfig = immutableSnapshot(options.gameConfig);
    validateVerticalSliceConfig(detachedConfig);
    if (!/^[0-9a-f]{64}$/.test(options.runtimeConfigHash)) throw new Error("runtimeConfigHash must be lowercase SHA-256");
    if (!Number.isSafeInteger(options.sessionSeed) || options.sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
    if (!(CATCH_LIGHT_RUNTIME_SLICE_LEVELS as readonly number[]).includes(options.sessionStartLevel)) {
      throw new Error(`sessionStartLevel ${options.sessionStartLevel} is not one of the released W2 runtime slices`);
    }

    this.gameConfig = detachedConfig;
    this.configByLevel = new Map(detachedConfig.levels.map(config => [config.level, config]));
    this.runtimeConfigHash = options.runtimeConfigHash;
    this.sessionSeed = options.sessionSeed;
    this.sessionStartLevel = options.sessionStartLevel;
    this.currentLevel = options.sessionStartLevel;
    this.sessionBackgroundId = this.requireLevelConfig(options.sessionStartLevel).backgroundId;
    this.batchStartDelaysMs = immutableSnapshot([...(options.batchStartDelaysMs ?? [])]);
    if (this.batchStartDelaysMs.length > PLANNED_BATCH_COUNT) throw new Error("too many batch start delays");
    for (const delay of this.batchStartDelaysMs) {
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > SESSION_DURATION_MS) {
        throw new Error("batch start delays must be safe integers in 0..300000");
      }
    }
    this.nextBatchStartActiveMs = this.delayForOrdinal(1);

    const previouslyIntroducedLevels = [...(options.previouslyIntroducedLevels ?? [])];
    const uniqueIntroducedLevels = new Set<number>();
    for (const introducedLevel of previouslyIntroducedLevels) {
      if (!Number.isSafeInteger(introducedLevel) || introducedLevel < 1 || introducedLevel > DESIGN_MAX_LEVEL) {
        throw new Error(`previouslyIntroducedLevels contains invalid level ${String(introducedLevel)}`);
      }
      if (uniqueIntroducedLevels.has(introducedLevel)) {
        throw new Error(`previouslyIntroducedLevels contains duplicate level ${introducedLevel}`);
      }
      uniqueIntroducedLevels.add(introducedLevel);
    }
    this.introducedLevels = uniqueIntroducedLevels;
    this.onBatchClosed = options.onBatchClosed;
  }

  get currentBatchView(): CatchLightCurrentBatchView | null {
    const batch = this.currentBatch;
    if (batch === null) return null;
    return immutableSnapshot({
      batchOrdinal: batch.batchOrdinal,
      levelBefore: batch.levelBefore,
      batchStartActiveMs: batch.batchStartActiveMs,
      operationStartActiveMs: batch.operationStartActiveMs,
      operationEndActiveMs: batch.operationEndActiveMs,
      closeAtActiveMs: batch.closeAtActiveMs,
      levelConfig: batch.levelConfig,
      schedule: batch.schedule,
    } satisfies CatchLightCurrentBatchView);
  }
  get closedBatches(): readonly CatchLightEligibleBatch[] { return immutableSnapshot(this.eligibleBatches); }
  get activeElapsedMs(): number { return this.latestActiveMs; }
  get isDeadlineReached(): boolean { return this.deadlineReached; }
  get pendingBatchNotificationCount(): number { return this.pendingBatchNotifications.length; }
  get isCurrentAdvanceSettled(): boolean {
    if (this.pendingBatchNotifications.length !== 0) return false;
    if (this.currentBatch !== null) {
      return this.latestActiveMs < this.currentBatch.closeAtActiveMs || this.currentBatch.closeAtActiveMs > SESSION_DURATION_MS;
    }
    return this.nextBatchOrdinal > PLANNED_BATCH_COUNT ||
      this.nextBatchStartActiveMs >= SESSION_DURATION_MS ||
      this.latestActiveMs < this.nextBatchStartActiveMs;
  }

  retryPendingBatchNotifications(): void {
    this.assertNotInBatchNotification();
    this.flushPendingBatchNotifications();
  }

  validatePauseInterval(pausedDurationMs: number): void {
    this.assertNotInBatchNotification();
    if (this.deadlineReached) throw new Error("cannot record pause after deadline");
    if (!Number.isSafeInteger(pausedDurationMs) || pausedDurationMs < 0) {
      throw new Error("pausedDurationMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.totalPausedDurationMs + pausedDurationMs)) {
      throw new Error("total paused duration exceeds safe integer range");
    }
    if (!Number.isSafeInteger(this.pauseCount + 1)) throw new Error("pause count exceeds safe integer range");
  }

  recordPauseInterval(pausedDurationMs: number): void {
    this.validatePauseInterval(pausedDurationMs);
    this.pauseCount += 1;
    this.totalPausedDurationMs += pausedDurationMs;
  }

  advanceToActive(activeMs: number): void {
    this.assertNotInBatchNotification();
    if (!Number.isSafeInteger(activeMs) || activeMs < 0 || activeMs > SESSION_DURATION_MS) throw new Error("activeMs outside 0..300000");
    if (activeMs < this.latestActiveMs) throw new Error("session active time moved backwards");
    if (this.deadlineReached && activeMs !== SESSION_DURATION_MS) throw new Error("cannot advance after deadline");

    // Invalid time input is rejected before an external callback can fire.
    this.flushPendingBatchNotifications();
    this.latestActiveMs = activeMs;

    while (true) {
      if (this.currentBatch === null) {
        if (this.nextBatchOrdinal > PLANNED_BATCH_COUNT || this.nextBatchStartActiveMs >= SESSION_DURATION_MS || activeMs < this.nextBatchStartActiveMs) break;
        const level = this.requireLevelConfig(this.currentLevel);
        const firstFormalTeachingBatch = !this.introducedLevels.has(level.level);
        const schedule = generateBatchSchedule(level, this.sessionSeed, this.nextBatchOrdinal, {
          backgroundIdOverride: this.sessionBackgroundId,
          firstFormalTeachingBatch,
        });
        this.currentBatch = new CatchLightBatchRuntime({
          batchOrdinal: this.nextBatchOrdinal,
          batchStartActiveMs: this.nextBatchStartActiveMs,
          levelBefore: this.currentLevel,
          consecutiveFailBefore: this.consecutiveFail,
          levelConfig: level,
          schedule,
        });
        this.introducedLevels.add(level.level);
      }

      const batch = this.currentBatch;
      if (activeMs >= batch.closeAtActiveMs && batch.closeAtActiveMs <= SESSION_DURATION_MS) {
        const closed = immutableSnapshot(batch.close(batch.closeAtActiveMs));
        // Commit all domain state before touching the external sink.
        this.eligibleBatches.push(closed);
        this.currentLevel = closed.levelAfter;
        this.consecutiveFail = closed.gameBatchMetrics.consecutiveFailAfter;
        this.currentBatch = null;
        this.nextBatchOrdinal += 1;
        this.nextBatchStartActiveMs = closed.closedAtActiveMs + this.delayForOrdinal(this.nextBatchOrdinal);
        if (this.onBatchClosed !== undefined) this.pendingBatchNotifications.push(closed);
        this.flushPendingBatchNotifications();
        continue;
      }
      batch.advanceToSessionActive(activeMs);
      break;
    }
  }

  touchInstance(instanceId: string, activeMs: number): TouchResult {
    this.advanceToActive(activeMs);
    if (activeMs >= SESSION_DURATION_MS || this.deadlineReached || this.currentBatch === null) return IGNORED_INPUT;
    return this.currentBatch.touchInstance(instanceId, activeMs);
  }

  touchBlank(activeMs: number): void {
    this.advanceToActive(activeMs);
    if (activeMs < SESSION_DURATION_MS && !this.deadlineReached && this.currentBatch !== null) this.currentBatch.touchBlank(activeMs);
  }

  deadline(): void {
    this.assertNotInBatchNotification();
    if (this.deadlineReached) return;
    this.advanceToActive(SESSION_DURATION_MS);
    if (this.currentBatch !== null && !this.currentBatch.isClosed) {
      const partialMetrics = this.currentBatch.sealIncompleteAt(SESSION_DURATION_MS);
      this.incompleteAudit = immutableSnapshot([{
        batchOrdinal: this.currentBatch.batchOrdinal,
        levelBefore: this.currentBatch.levelBefore,
        cutoffReason: "DEADLINE",
        startedAtActiveMs: this.currentBatch.batchStartActiveMs,
        cutoffAtActiveMs: SESSION_DURATION_MS,
        partialMetrics,
      }]);
    }
    this.deadlineReached = true;
  }

  snapshotAtActive(activeMs: number): CatchLightSessionSnapshot {
    this.advanceToActive(activeMs);
    return this.snapshot();
  }

  snapshot(): CatchLightSessionSnapshot {
    this.assertNotInBatchNotification();
    const currentBatch = this.currentBatch === null ? null : this.currentBatch.snapshotAt(this.latestActiveMs);
    const snapshot = {
      activeElapsedMs: this.latestActiveMs,
      sessionStartLevel: this.sessionStartLevel,
      currentLevel: this.currentLevel,
      backgroundId: this.sessionBackgroundId,
      deadlineReached: this.deadlineReached,
      eligibleBatchCount: this.eligibleBatches.length,
      sessionRawScore: this.eligibleBatches.reduce((sum, batch) => sum + batch.batchScore, 0),
      nextBatchOrdinal: this.nextBatchOrdinal,
      consecutiveFail: this.consecutiveFail,
      pendingBatchNotificationCount: this.pendingBatchNotifications.length,
      pendingBatchNotificationHashes: this.pendingBatchNotifications.map(batch => batch.batchPayloadSha256),
      currentBatch,
    } satisfies CatchLightSessionSnapshot;
    return immutableSnapshot(snapshot);
  }

  buildResultDraft(): CatchLightGameResultDraft {
    this.assertNotInBatchNotification();
    if (!this.deadlineReached) throw new Error("result draft is unavailable before the 300000ms deadline");
    if (this.pendingBatchNotifications.length > 0) throw new Error("result draft is unavailable while batch-close notifications are pending");
    const eligible = immutableSnapshot(this.eligibleBatches);
    const incomplete = immutableSnapshot([...this.incompleteAudit]);
    const presentedLevels = [this.sessionStartLevel, ...eligible.map(batch => batch.levelBefore), ...incomplete.map(audit => audit.levelBefore)];
    const passedLevels = eligible.filter(batch => batch.resultZone === "UPGRADE").map(batch => batch.levelBefore);
    const eligibleMetrics = eligible.map(batch => batch.gameBatchMetrics);
    const currentPartial = incomplete[0]?.partialMetrics ?? null;
    const totalObjectTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.totalObjectTouches, 0)
      + (currentPartial?.totalObjectTouches ?? 0);
    const blankTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.blankTouches, 0)
      + (currentPartial?.blankTouches ?? 0);
    const duplicateTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.duplicateTouches, 0)
      + (currentPartial?.duplicateTouches ?? 0);
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
    const result = {
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
    } satisfies CatchLightGameResultDraft;
    return immutableSnapshot(result);
  }

  private flushPendingBatchNotifications(): void {
    if (this.pendingBatchNotifications.length === 0) return;
    if (this.onBatchClosed === undefined) {
      this.pendingBatchNotifications.length = 0;
      return;
    }
    if (this.flushingBatchNotifications) throw new Error("onBatchClosed callback must not re-enter the Catch Light session");
    this.flushingBatchNotifications = true;
    try {
      while (this.pendingBatchNotifications.length > 0) {
        const next = this.pendingBatchNotifications[0]!;
        this.onBatchClosed(immutableSnapshot(next));
        this.pendingBatchNotifications.shift();
      }
    } finally {
      this.flushingBatchNotifications = false;
    }
  }

  private assertNotInBatchNotification(): void {
    if (this.flushingBatchNotifications) throw new Error("onBatchClosed callback must not re-enter the Catch Light session");
  }

  private delayForOrdinal(ordinal: number): number {
    if (ordinal < 1 || ordinal > PLANNED_BATCH_COUNT) return 0;
    return this.batchStartDelaysMs[ordinal - 1] ?? 0;
  }

  private requireLevelConfig(level: number): CatchLightLevelConfig {
    const config = this.configByLevel.get(level);
    if (config !== undefined) return config;
    const lastClosed = this.eligibleBatches.at(-1);
    if (lastClosed !== undefined && lastClosed.levelAfter === level) {
      throw new UnsupportedSliceTransitionError(lastClosed.levelBefore, level, this.nextBatchOrdinal);
    }
    throw new Error(`level ${level} is absent from W2 vertical slices; refusing implicit fallback`);
  }
}
