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
import { getVerticalSliceLevelConfig } from "../config/vertical-slices.js";
import type { GeneratedBatchPlan, TouchResult } from "../types.js";
import { SignalStationBatchRuntime, type ClosedBatchResult } from "./batch-runtime.js";

export interface SignalStationSessionOptions {
  readonly sessionSeed: number;
  readonly sessionStartLevel: number;
  readonly runtimeConfigHash: string;
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
  private incomplete: IncompleteBatchAudit[] = [];
  private latestActiveMs = 0;
  private highestPresentedValue: number;
  private finalized = false;
  private terminated = false;
  private pauseCountValue = 0;
  private totalPausedUptimeValue = 0;
  private generatedWaveCountValue = 0;
  private drainedClosedCount = 0;

  constructor(options: SignalStationSessionOptions) {
    if (!Number.isSafeInteger(options.sessionSeed) || options.sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
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

  startBatch(startedAtActiveMs: number): GeneratedBatchPlan {
    if (this.finalized || this.terminated) throw new Error("session is no longer accepting batches");
    if (this.currentBatchValue !== null) throw new Error("a batch is already active");
    if (this.eligible.length >= PLANNED_BATCH_COUNT) throw new Error("planned batch count already reached");
    const previousClose = this.eligible[this.eligible.length - 1]?.closedAtActiveMs ?? 0;
    if (!Number.isSafeInteger(startedAtActiveMs) || startedAtActiveMs < previousClose || startedAtActiveMs >= SESSION_DURATION_MS) {
      throw new Error("invalid batch start active time");
    }
    const ordinal = this.eligible.length + 1;
    const config = getVerticalSliceLevelConfig(this.currentLevelValue);
    this.currentBatchValue = new SignalStationBatchRuntime(config, this.sessionSeed, ordinal, startedAtActiveMs);
    this.latestActiveMs = Math.max(this.latestActiveMs, startedAtActiveMs);
    this.highestPresentedValue = Math.max(this.highestPresentedValue, this.currentLevelValue);
    this.generatedWaveCountValue += 8;
    return this.currentBatchValue.plan;
  }

  touch(instanceId: string | null, activeMs: number, eventId: string): TouchResult {
    if (this.finalized || this.terminated || activeMs >= SESSION_DURATION_MS) {
      return Object.freeze({disposition: "IGNORED_OUTSIDE_WINDOW", instanceId, stateAfter: null, hitDelta: 0, falseTouchDelta: 0});
    }
    const batch = this.currentBatchValue;
    if (batch === null) return Object.freeze({disposition: "IGNORED_BLANK", instanceId: null, stateAfter: null, hitDelta: 0, falseTouchDelta: 0});
    const result = batch.touch(instanceId, activeMs, eventId);
    this.latestActiveMs = Math.max(this.latestActiveMs, activeMs);
    return result;
  }

  advanceTo(activeMs: number): EligibleBatch | null {
    if (!Number.isSafeInteger(activeMs) || activeMs < this.latestActiveMs || activeMs > SESSION_DURATION_MS) {
      throw new Error("session active time cannot move backwards or exceed 300000ms");
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
    if (!Number.isSafeInteger(pausedUptimeMs) || pausedUptimeMs < 0) throw new Error("pausedUptimeMs must be non-negative");
    this.pauseCountValue += 1;
    this.totalPausedUptimeValue += pausedUptimeMs;
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
    if (this.finalized) throw new Error("finalized session cannot be terminated");
    this.terminated = true;
    this.currentBatchValue = null;
    this.incomplete = [];
  }

  drainClosedBatchDrafts(): EligibleBatch[] {
    const pending = this.eligible.slice(this.drainedClosedCount).map(batch => ({...batch}));
    this.drainedClosedCount = this.eligible.length;
    return pending;
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
    const gameMetrics: Record<string, unknown> = {
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
      generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
      configVersion: SIGNAL_STATION_CONFIG_VERSION,
      scoringRuleVersion: SIGNAL_STATION_SCORING_RULE_VERSION,
      requirementVersion: SIGNAL_STATION_REQUIREMENT_VERSION,
      contentVersion: SIGNAL_STATION_CONTENT_VERSION,
      fullLevelSetStatus: "HOLD",
      implementedLevels: [...IMPLEMENTED_VERTICAL_SLICE_LEVELS],
    };
    return Object.freeze({
      gameCode: SIGNAL_STATION_GAME_CODE,
      gamePayloadVersion: "A620-GP-1.1",
      runtimeConfigHash: this.runtimeConfigHash,
      designMaxLevel: 96,
      plannedBatchCount: PLANNED_BATCH_COUNT,
      eligibleBatchCount: this.eligible.length,
      eligibleBatches: this.eligible.map(batch => ({...batch})),
      incompleteBatchAudit: this.incomplete.map(audit => ({...audit})),
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
