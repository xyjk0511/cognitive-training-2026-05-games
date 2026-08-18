import type { EligibleBatch, GameResultDraft, IncompleteBatchAudit } from "../../../contracts.js";
import {
  IMPLEMENTED_VERTICAL_SLICE_LEVELS,
  PLANNED_BATCH_COUNT,
  SESSION_DURATION_MS,
  SIGNAL_STATION_CONFIG_VERSION,
  SIGNAL_STATION_CONTENT_VERSION,
  SIGNAL_STATION_GAME_CODE,
  SIGNAL_STATION_GENERATOR_VERSION,
  SIGNAL_STATION_REQUIREMENT_VERSION,
  SIGNAL_STATION_SCORING_RULE_VERSION,
} from "../constants.js";
import {
  getVerticalSliceLevelConfig, isVerticalSliceLevelImplemented,
} from "../config/vertical-slices.js";
import type {
  GeneratedBatchPlan, TouchResult, VerticalSliceCoverageBlock,
} from "../types.js";
import { SignalStationBatchRuntime, type ClosedBatchResult } from "./batch-runtime.js";

export interface SignalStationSessionOptions {
  readonly sessionSeed: number;
  readonly sessionStartLevel: number;
  readonly runtimeConfigHash: string;
}

function requireActiveMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > SESSION_DURATION_MS) {
    throw new Error(`${name} must be a safe integer in [0,300000]`);
  }
}

function checkedAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} exceeded the safe-integer range`);
  return result;
}

function ignoredOutside(instanceId: string | null): TouchResult {
  return Object.freeze({
    disposition: "IGNORED_OUTSIDE_WINDOW",
    instanceId,
    stateAfter: null,
    hitDelta: 0,
    falseTouchDelta: 0,
  });
}

function immutableEligibleBatch(batch: EligibleBatch): EligibleBatch {
  return Object.freeze({
    ...batch,
    gameBatchMetrics: Object.freeze({...batch.gameBatchMetrics}),
  });
}

function immutableIncompleteAudit(audit: IncompleteBatchAudit): IncompleteBatchAudit {
  return Object.freeze({
    ...audit,
    partialMetrics: Object.freeze({...audit.partialMetrics}),
  });
}

function immutableEligibleBatchArray(batches: readonly EligibleBatch[]): EligibleBatch[] {
  return Object.freeze(batches.map(immutableEligibleBatch)) as unknown as EligibleBatch[];
}

function immutableIncompleteAuditArray(audits: readonly IncompleteBatchAudit[]): IncompleteBatchAudit[] {
  return Object.freeze(audits.map(immutableIncompleteAudit)) as unknown as IncompleteBatchAudit[];
}

export class SignalStationSession {
  readonly sessionSeed: number;
  readonly sessionStartLevel: number;
  readonly runtimeConfigHash: string;
  private currentLevelValue: number;
  private consecutiveFailCount: 0 | 1 = 0;
  private currentBatchValue: SignalStationBatchRuntime | null = null;
  private readonly eligible: EligibleBatch[] = [];
  private readonly closedResults: ClosedBatchResult[] = [];
  private readonly processedEventIds = new Set<string>();
  private incomplete: IncompleteBatchAudit[] = [];
  private latestActiveMs = 0;
  private highestPresentedValue: number;
  private finalized = false;
  private terminated = false;
  private pauseCountValue = 0;
  private totalPausedUptimeValue = 0;
  private generatedWaveCountValue = 0;
  private acknowledgedClosedCount = 0;
  private coverageBlockValue: VerticalSliceCoverageBlock | null = null;

  constructor(options: SignalStationSessionOptions) {
    if (!Number.isSafeInteger(options.sessionSeed) || options.sessionSeed < 0) {
      throw new Error("sessionSeed must be a non-negative safe integer");
    }
    getVerticalSliceLevelConfig(options.sessionStartLevel);
    if (!/^[0-9a-f]{64}$/.test(options.runtimeConfigHash)) throw new Error("runtimeConfigHash must be lowercase SHA-256");
    this.sessionSeed = options.sessionSeed;
    this.sessionStartLevel = options.sessionStartLevel;
    this.currentLevelValue = options.sessionStartLevel;
    this.highestPresentedValue = options.sessionStartLevel;
    this.runtimeConfigHash = options.runtimeConfigHash;
  }

  get currentLevel(): number { return this.currentLevelValue; }
  get currentBatch(): SignalStationBatchRuntime | null { return this.currentBatchValue; }
  get eligibleBatchCount(): number { return this.eligible.length; }
  get isFinalized(): boolean { return this.finalized; }
  get currentActiveMs(): number { return this.latestActiveMs; }
  get coverageBlock(): VerticalSliceCoverageBlock | null { return this.coverageBlockValue; }

  startBatch(startedAtActiveMs: number): GeneratedBatchPlan {
    if (this.finalized || this.terminated) throw new Error("session is no longer accepting batches");
    if (this.coverageBlockValue !== null) {
      throw new Error(`vertical slice is blocked at unimplemented level ${this.coverageBlockValue.blockedLevel}`);
    }
    if (this.currentBatchValue !== null) throw new Error("a batch is already active");
    if (this.eligible.length >= PLANNED_BATCH_COUNT) throw new Error("planned batch count already reached");
    requireActiveMs(startedAtActiveMs, "startedAtActiveMs");
    const previousClose = this.eligible[this.eligible.length - 1]?.closedAtActiveMs ?? 0;
    if (startedAtActiveMs < previousClose || startedAtActiveMs < this.latestActiveMs || startedAtActiveMs >= SESSION_DURATION_MS) {
      throw new Error("batch start cannot precede the prior close/current active time or reach the deadline");
    }
    const ordinal = this.eligible.length + 1;
    const config = getVerticalSliceLevelConfig(this.currentLevelValue);
    this.currentBatchValue = new SignalStationBatchRuntime(config, this.sessionSeed, ordinal, startedAtActiveMs);
    this.latestActiveMs = startedAtActiveMs;
    this.highestPresentedValue = Math.max(this.highestPresentedValue, this.currentLevelValue);
    this.generatedWaveCountValue = checkedAdd(this.generatedWaveCountValue, 8, "generatedWaveCount");
    return this.currentBatchValue.plan;
  }

  markVerticalSliceCoverageBlocked(): VerticalSliceCoverageBlock {
    if (this.finalized || this.terminated) throw new Error("cannot mark coverage after session closure");
    if (this.currentBatchValue !== null) throw new Error("coverage can be blocked only between batches");
    if (isVerticalSliceLevelImplemented(this.currentLevelValue)) {
      throw new Error(`level ${this.currentLevelValue} is implemented and must not be marked blocked`);
    }
    const last = this.eligible[this.eligible.length - 1];
    if (last === undefined || last.levelAfter !== this.currentLevelValue) {
      throw new Error("coverage block must follow the batch transition that selected the unimplemented level");
    }
    if (this.coverageBlockValue !== null) {
      if (this.coverageBlockValue.blockedLevel !== this.currentLevelValue
        || this.coverageBlockValue.afterBatchOrdinal !== last.batchOrdinal) {
        throw new Error("conflicting vertical-slice coverage block");
      }
      return this.coverageBlockValue;
    }
    this.coverageBlockValue = Object.freeze({
      reason: "LEVEL_NOT_IMPLEMENTED",
      blockedLevel: this.currentLevelValue,
      afterBatchOrdinal: last.batchOrdinal,
    });
    return this.coverageBlockValue;
  }

  touch(instanceId: string | null, activeMs: number, eventId: string): TouchResult {
    requireActiveMs(activeMs, "activeMs");
    if (typeof eventId !== "string" || eventId.length === 0) throw new Error("eventId must not be empty");
    if (this.processedEventIds.has(eventId)) {
      return Object.freeze({
        disposition: "IGNORED_DUPLICATE_EVENT",
        instanceId,
        stateAfter: null,
        hitDelta: 0,
        falseTouchDelta: 0,
      });
    }
    if (activeMs < this.latestActiveMs) throw new Error("session active time cannot move backwards");
    if (this.finalized || this.terminated || activeMs >= SESSION_DURATION_MS) return ignoredOutside(instanceId);
    this.processedEventIds.add(eventId);
    this.latestActiveMs = activeMs;
    const batch = this.currentBatchValue;
    if (batch === null) {
      return Object.freeze({disposition: "IGNORED_BLANK", instanceId: null, stateAfter: null, hitDelta: 0, falseTouchDelta: 0});
    }
    return batch.touch(instanceId, activeMs, eventId);
  }

  advanceTo(activeMs: number): EligibleBatch | null {
    requireActiveMs(activeMs, "activeMs");
    if (activeMs < this.latestActiveMs) throw new Error("session active time cannot move backwards");
    if (this.terminated) throw new Error("terminated session cannot advance");
    if (this.finalized) {
      if (activeMs !== this.latestActiveMs) throw new Error("finalized session cannot advance");
      return null;
    }
    this.latestActiveMs = activeMs;
    const batch = this.currentBatchValue;
    if (batch === null) return null;
    batch.advanceTo(activeMs);
    if (activeMs < batch.batchEndActiveMs) return null;
    const closed = batch.closeAt(activeMs, this.consecutiveFailCount);
    this.eligible.push(closed.eligibleBatch);
    this.closedResults.push(closed);
    this.currentLevelValue = closed.eligibleBatch.levelAfter;
    this.consecutiveFailCount = closed.consecutiveFailCountAfter;
    this.currentBatchValue = null;
    return closed.eligibleBatch;
  }

  recordPause(pausedUptimeMs: number): void {
    if (this.finalized || this.terminated) throw new Error("closed session cannot record a pause");
    if (!Number.isSafeInteger(pausedUptimeMs) || pausedUptimeMs < 0) throw new Error("pausedUptimeMs must be non-negative");
    this.pauseCountValue = checkedAdd(this.pauseCountValue, 1, "pauseCount");
    this.totalPausedUptimeValue = checkedAdd(this.totalPausedUptimeValue, pausedUptimeMs, "totalPausedUptimeMs");
  }

  deadline(): void {
    if (this.terminated) throw new Error("terminated session cannot form a result draft");
    if (this.finalized) return;
    this.advanceTo(SESSION_DURATION_MS);
    if (this.currentBatchValue !== null) {
      this.incomplete = [this.currentBatchValue.partialAudit(SESSION_DURATION_MS)];
      this.currentBatchValue = null;
    }
    this.finalized = true;
  }

  terminate(): void {
    if (this.terminated) throw new Error("session is already terminated");
    this.terminated = true;
    this.currentBatchValue = null;
    this.incomplete = [];
  }

  /**
   * Returns immutable evidence that the host has not durably acknowledged yet.
   * Reading is intentionally non-destructive so a failed host transaction can
   * retry the same ordinal/hash without replaying game-domain mutations.
   */
  drainClosedBatchDrafts(): EligibleBatch[] {
    if (this.terminated) throw new Error("terminated session cannot emit BATCH_CLOSED drafts");
    return immutableEligibleBatchArray(this.eligible.slice(this.acknowledgedClosedCount));
  }

  acknowledgeClosedBatchDraft(batchPayloadSha256: string): void {
    if (this.terminated) throw new Error("terminated session cannot acknowledge BATCH_CLOSED drafts");
    const pending = this.eligible[this.acknowledgedClosedCount];
    if (pending === undefined) throw new Error("there is no pending BATCH_CLOSED draft to acknowledge");
    if (pending.batchPayloadSha256 !== batchPayloadSha256) {
      throw new Error("BATCH_CLOSED acknowledgement must match the first pending batch hash");
    }
    this.acknowledgedClosedCount += 1;
  }

  closedPlans(): readonly GeneratedBatchPlan[] {
    return Object.freeze(this.closedResults.map(result => result.plan));
  }

  buildResultDraft(): GameResultDraft {
    if (!this.finalized || this.terminated) throw new Error("result draft is available only after normal deadline finalization");
    const last = this.eligible[this.eligible.length - 1];
    const sessionEndLevel = last?.levelAfter ?? this.sessionStartLevel;
    const passedLevels = this.eligible.filter(batch => batch.resultZone === "UPGRADE").map(batch => batch.levelBefore);
    const batchMetrics = this.eligible.map(batch => batch.gameBatchMetrics);
    const reactionMins = batchMetrics.map(metrics => metrics["reactionTimeMinMs"]).filter((value): value is number => typeof value === "number");
    const reactionMaxes = batchMetrics.map(metrics => metrics["reactionTimeMaxMs"]).filter((value): value is number => typeof value === "number");
    const gameMetrics: Record<string, unknown> = Object.freeze({
      totalH: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["H"]), 0),
      totalT: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["T"]), 0),
      totalF: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["F"]), 0),
      totalD: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["D"]), 0),
      reactionTimeCount: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["reactionTimeCount"]), 0),
      reactionTimeTotalMs: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["reactionTimeTotalMs"]), 0),
      reactionTimeMinMs: reactionMins.length === 0 ? null : Math.min(...reactionMins),
      reactionTimeMaxMs: reactionMaxes.length === 0 ? null : Math.max(...reactionMaxes),
      doubleIntervalCount: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["doubleIntervalCount"]), 0),
      doubleIntervalTotalMs: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["doubleIntervalTotalMs"]), 0),
      pauseCount: this.pauseCountValue,
      totalPausedUptimeMs: this.totalPausedUptimeValue,
      generatedBatchCount: this.eligible.length + this.incomplete.length,
      generatedWaveCount: this.generatedWaveCountValue,
      eligibleBatchCount: this.eligible.length,
      incompleteBatchCount: this.incomplete.length,
      verticalSliceCoverageBlocked: this.coverageBlockValue !== null,
      verticalSliceCoverageBlockReason: this.coverageBlockValue?.reason ?? null,
      verticalSliceBlockedLevel: this.coverageBlockValue?.blockedLevel ?? null,
      verticalSliceBlockedAfterBatchOrdinal: this.coverageBlockValue?.afterBatchOrdinal ?? null,
      generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
      configVersion: SIGNAL_STATION_CONFIG_VERSION,
      scoringRuleVersion: SIGNAL_STATION_SCORING_RULE_VERSION,
      requirementVersion: SIGNAL_STATION_REQUIREMENT_VERSION,
      contentVersion: SIGNAL_STATION_CONTENT_VERSION,
      fullLevelSetStatus: "HOLD",
      implementedLevels: Object.freeze([...IMPLEMENTED_VERTICAL_SLICE_LEVELS]),
    });
    const eligibleBatches = immutableEligibleBatchArray(this.eligible);
    const incompleteBatchAudit = immutableIncompleteAuditArray(this.incomplete);
    return Object.freeze({
      gameCode: SIGNAL_STATION_GAME_CODE,
      gamePayloadVersion: "A620-GP-1.1",
      runtimeConfigHash: this.runtimeConfigHash,
      designMaxLevel: 96,
      plannedBatchCount: PLANNED_BATCH_COUNT,
      eligibleBatchCount: this.eligible.length,
      eligibleBatches,
      incompleteBatchAudit,
      sessionStartLevel: this.sessionStartLevel,
      sessionEndLevel,
      sessionHighestPresentedLevel: this.highestPresentedValue,
      sessionHighestPassedLevel: passedLevels.length === 0 ? null : Math.max(...passedLevels),
      nextStartLevel: sessionEndLevel,
      sessionRawScore: this.eligible.reduce((sum, batch) => sum + batch.batchScore, 0),
      sessionRawScoreMax: 800,
      actualTrainingMs: SESSION_DURATION_MS,
      gameMetrics,
    });
  }
}
