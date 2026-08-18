import { canonicalSha256 } from "../../../canonical.js";
import type { EligibleBatch, IncompleteBatchAudit } from "../../../contracts.js";
import { BATCH_DURATION_MS, TIMING_PROFILES } from "../constants.js";
import { generateBatchPlan } from "../generator/wave-generator.js";
import { decideLevelTransition, scoreBatch } from "../scoring/scoring.js";
import type {
  BatchMetrics, GeneratedBatchPlan, LevelConfig, PartialMetrics, TouchResult,
} from "../types.js";
import { SignalInstanceRuntime, summarizeIntegerDurations, type InstanceAudit } from "./signal-instance.js";

export interface ClosedBatchResult {
  readonly eligibleBatch: EligibleBatch;
  readonly consecutiveFailCountAfter: 0 | 1;
  readonly plan: GeneratedBatchPlan;
  readonly audits: readonly InstanceAudit[];
}

function batchMetricsRecord(metrics: BatchMetrics): Record<string, unknown> {
  return {
    H: metrics.H,
    T: metrics.T,
    F: metrics.F,
    D: metrics.D,
    timingProfile: metrics.timingProfile,
    targetClassCount: metrics.targetClassCount,
    similarityTier: metrics.similarityTier,
    directionCount: metrics.directionCount,
    doubleCount: metrics.doubleCount,
    completedDoubleCount: metrics.completedDoubleCount,
    timedOutDoubleCount: metrics.timedOutDoubleCount,
    presentedWaveCount: metrics.presentedWaveCount,
    reactionTimeCount: metrics.reactionTimeCount,
    reactionTimeTotalMs: metrics.reactionTimeTotalMs,
    reactionTimeMinMs: metrics.reactionTimeMinMs,
    reactionTimeMaxMs: metrics.reactionTimeMaxMs,
    doubleIntervalCount: metrics.doubleIntervalCount,
    doubleIntervalTotalMs: metrics.doubleIntervalTotalMs,
  };
}

function partialMetricsRecord(metrics: PartialMetrics): Record<string, unknown> {
  return {
    waveOrdinal: metrics.waveOrdinal,
    presentedTargetCount: metrics.presentedTargetCount,
    presentedDistractorCount: metrics.presentedDistractorCount,
    H: metrics.H,
    F: metrics.F,
    waitingDoubleCount: metrics.waitingDoubleCount,
    completedDoubleCount: metrics.completedDoubleCount,
    timedOutTargetCount: metrics.timedOutTargetCount,
    activeElapsedInBatchMs: metrics.activeElapsedInBatchMs,
  };
}

export class SignalStationBatchRuntime {
  readonly config: LevelConfig;
  readonly plan: GeneratedBatchPlan;
  readonly batchOrdinal: number;
  readonly batchStartActiveMs: number;
  readonly batchEndActiveMs: number;
  private readonly instances: SignalInstanceRuntime[];
  private readonly instanceById = new Map<string, SignalInstanceRuntime>();
  private readonly processedEventIds = new Set<string>();
  private latestActiveMs: number;
  private closed = false;

  constructor(config: LevelConfig, sessionSeed: number, batchOrdinal: number, batchStartActiveMs: number) {
    if (!Number.isSafeInteger(batchStartActiveMs) || batchStartActiveMs < 0) throw new Error("batchStartActiveMs must be non-negative");
    this.config = config;
    this.batchOrdinal = batchOrdinal;
    this.batchStartActiveMs = batchStartActiveMs;
    this.batchEndActiveMs = batchStartActiveMs + BATCH_DURATION_MS;
    this.latestActiveMs = batchStartActiveMs;
    this.plan = generateBatchPlan(config, sessionSeed, batchOrdinal);
    const profile = TIMING_PROFILES[config.timingProfile];
    this.instances = this.plan.waves.flatMap(wave => wave.instances).map(definition =>
      new SignalInstanceRuntime(definition, batchStartActiveMs, profile.enteringMs, profile.activeMs, profile.doubleWindowMs));
    for (const instance of this.instances) {
      if (this.instanceById.has(instance.definition.instanceId)) throw new Error("duplicate generated instanceId");
      this.instanceById.set(instance.definition.instanceId, instance);
    }
  }

  get isClosed(): boolean { return this.closed; }
  get currentActiveMs(): number { return this.latestActiveMs; }

  advanceTo(activeMs: number): void {
    if (!Number.isSafeInteger(activeMs) || activeMs < this.latestActiveMs) throw new Error("batch active time cannot move backwards");
    this.latestActiveMs = activeMs;
    for (const instance of this.instances) instance.advanceTo(activeMs);
  }

  touch(instanceId: string | null, activeMs: number, eventId: string): TouchResult {
    if (this.closed) throw new Error("closed batch cannot receive input");
    if (eventId.length === 0) throw new Error("eventId must not be empty");
    if (this.processedEventIds.has(eventId)) {
      return Object.freeze({
        disposition: "IGNORED_DUPLICATE_EVENT",
        instanceId,
        stateAfter: instanceId === null ? null : this.instanceById.get(instanceId)?.stateAt(this.latestActiveMs) ?? null,
        hitDelta: 0,
        falseTouchDelta: 0,
      });
    }
    this.advanceTo(activeMs);
    this.processedEventIds.add(eventId);
    if (instanceId === null) {
      return Object.freeze({disposition: "IGNORED_BLANK", instanceId: null, stateAfter: null, hitDelta: 0, falseTouchDelta: 0});
    }
    const instance = this.instanceById.get(instanceId);
    if (instance === undefined) {
      return Object.freeze({disposition: "IGNORED_BLANK", instanceId: null, stateAfter: null, hitDelta: 0, falseTouchDelta: 0});
    }
    return instance.touch(activeMs, eventId);
  }

  metrics(): BatchMetrics {
    const hits = this.instances.filter(instance => instance.definition.role === "TARGET" && instance.outcome === "HIT").length;
    const falseTouches = this.instances.filter(instance => instance.definition.role === "DISTRACTOR" && instance.outcome === "FALSE_TOUCH").length;
    const completedDouble = this.instances.filter(instance => instance.definition.requiresDouble && instance.outcome === "HIT").length;
    const timedOutDouble = this.instances.filter(instance => instance.definition.requiresDouble && instance.outcome === "MISS").length;
    const reactionTimes = this.instances
      .filter(instance => instance.definition.role === "TARGET")
      .map(instance => instance.firstReactionMs())
      .filter((value): value is number => value !== null);
    const doubleIntervals = this.instances.map(instance => instance.doubleIntervalMs()).filter((value): value is number => value !== null);
    const reactions = summarizeIntegerDurations(reactionTimes);
    const intervals = summarizeIntegerDurations(doubleIntervals);
    return Object.freeze({
      H: hits,
      T: this.plan.targetTotal,
      F: falseTouches,
      D: this.plan.distractorTotal,
      timingProfile: this.config.timingProfile,
      targetClassCount: this.config.targetClassCount,
      similarityTier: this.config.similarityTier,
      directionCount: this.config.directionCount,
      doubleCount: this.config.doubleCount,
      completedDoubleCount: completedDouble,
      timedOutDoubleCount: timedOutDouble,
      presentedWaveCount: 8,
      reactionTimeCount: reactions.count,
      reactionTimeTotalMs: reactions.totalMs,
      reactionTimeMinMs: reactions.minMs,
      reactionTimeMaxMs: reactions.maxMs,
      doubleIntervalCount: intervals.count,
      doubleIntervalTotalMs: intervals.totalMs,
    });
  }

  closeAt(activeMs: number, consecutiveFailCountBefore: 0 | 1): ClosedBatchResult {
    if (this.closed) throw new Error("batch already closed");
    if (activeMs < this.batchEndActiveMs) throw new Error("batch cannot close before its 37500ms boundary");
    if (this.latestActiveMs < this.batchEndActiveMs) this.advanceTo(this.batchEndActiveMs);
    const metrics = this.metrics();
    const score = scoreBatch(this.config.waveTemplate, metrics.H, metrics.T, metrics.F, metrics.D);
    const level = decideLevelTransition(this.config.level, score.resultZone, consecutiveFailCountBefore);
    const projection = {
      batchOrdinal: this.batchOrdinal,
      closed: true as const,
      decisionEligible: true as const,
      levelBefore: this.config.level,
      resultZone: score.resultZone,
      levelTransition: level.levelTransition,
      levelAfter: level.levelAfter,
      batchScore: score.batchScore,
      closedAtActiveMs: this.batchEndActiveMs,
      gameBatchMetrics: batchMetricsRecord(metrics),
    };
    const eligibleBatch: EligibleBatch = Object.freeze({
      ...projection,
      batchPayloadSha256: canonicalSha256(projection),
    });
    this.closed = true;
    return Object.freeze({
      eligibleBatch,
      consecutiveFailCountAfter: level.consecutiveFailCountAfter,
      plan: this.plan,
      audits: Object.freeze(this.instances.map(instance => instance.audit())),
    });
  }

  partialAudit(cutoffAtActiveMs: 300000): IncompleteBatchAudit {
    if (this.closed) throw new Error("closed batch has no partial audit");
    this.advanceTo(cutoffAtActiveMs);
    const presented = this.instances.filter(instance => instance.isPresentedBefore(cutoffAtActiveMs));
    const waveOrdinal = presented.reduce((maximum, instance) => Math.max(maximum, instance.definition.waveOrdinal), 0);
    const partial: PartialMetrics = Object.freeze({
      waveOrdinal,
      presentedTargetCount: presented.filter(instance => instance.definition.role === "TARGET").length,
      presentedDistractorCount: presented.filter(instance => instance.definition.role === "DISTRACTOR").length,
      H: presented.filter(instance => instance.definition.role === "TARGET" && instance.outcome === "HIT").length,
      F: presented.filter(instance => instance.definition.role === "DISTRACTOR" && instance.outcome === "FALSE_TOUCH").length,
      waitingDoubleCount: presented.filter(instance => instance.definition.requiresDouble && instance.outcome === "PENDING" && instance.firstTouchActiveMs !== null).length,
      completedDoubleCount: presented.filter(instance => instance.definition.requiresDouble && instance.outcome === "HIT").length,
      timedOutTargetCount: presented.filter(instance => instance.definition.role === "TARGET" && instance.outcome === "MISS").length,
      activeElapsedInBatchMs: Math.max(0, cutoffAtActiveMs - this.batchStartActiveMs),
    });
    return Object.freeze({
      batchOrdinal: this.batchOrdinal,
      levelBefore: this.config.level,
      cutoffReason: "DEADLINE",
      startedAtActiveMs: this.batchStartActiveMs,
      cutoffAtActiveMs,
      partialMetrics: partialMetricsRecord(partial),
    });
  }

  instanceAudits(): readonly InstanceAudit[] {
    return Object.freeze(this.instances.map(instance => instance.audit()));
  }
}
