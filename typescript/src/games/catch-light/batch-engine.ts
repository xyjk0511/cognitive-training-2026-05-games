import { canonicalSha256 } from "../../canonical.js";
import { FruitObjectRuntime } from "./object-machine.js";
import { applyLevelDecision, batchScore, resultZone } from "./scoring.js";
import {
  BATCH_DURATION_MS,
  FEEDBACK_DURATION_MS,
  OPERATION_DURATION_MS,
  PROMPT_DURATION_MS,
  SESSION_DURATION_MS,
  TRANSITION_DURATION_MS,
  type BatchMetrics,
  type CatchLightEligibleBatch,
  type CatchLightLevelConfig,
  type GeneratedBatchSchedule,
  type InstanceAudit,
  type PartialBatchMetrics,
  type TouchResult,
} from "./types.js";

const IGNORED_PHASE: TouchResult = Object.freeze({
  disposition: "IGNORED_WRONG_INSTANCE_PHASE",
  changedStatistics: false,
  hitDelta: 0,
  falseTouchDelta: 0,
});

export class CatchLightBatchRuntime {
  readonly batchOrdinal: number;
  readonly batchStartActiveMs: number;
  readonly operationStartActiveMs: number;
  readonly operationEndActiveMs: number;
  readonly closeAtActiveMs: number;
  readonly levelBefore: number;
  readonly consecutiveFailBefore: 0 | 1;
  readonly levelConfig: CatchLightLevelConfig;
  readonly schedule: GeneratedBatchSchedule;

  private readonly objects: Map<string, FruitObjectRuntime>;
  private H = 0;
  private F = 0;
  private totalObjectTouches = 0;
  private blankTouches = 0;
  private duplicateTouches = 0;
  private latestSessionActiveMs: number;
  private closedBatch: CatchLightEligibleBatch | null = null;

  constructor(args: {
    batchOrdinal: number;
    batchStartActiveMs: number;
    levelBefore: number;
    consecutiveFailBefore: 0 | 1;
    levelConfig: CatchLightLevelConfig;
    schedule: GeneratedBatchSchedule;
  }) {
    this.batchOrdinal = args.batchOrdinal;
    this.batchStartActiveMs = args.batchStartActiveMs;
    this.operationStartActiveMs = args.batchStartActiveMs + PROMPT_DURATION_MS;
    this.operationEndActiveMs = this.operationStartActiveMs + OPERATION_DURATION_MS;
    this.closeAtActiveMs = args.batchStartActiveMs + BATCH_DURATION_MS;
    this.levelBefore = args.levelBefore;
    this.consecutiveFailBefore = args.consecutiveFailBefore;
    this.levelConfig = args.levelConfig;
    this.schedule = args.schedule;
    this.latestSessionActiveMs = args.batchStartActiveMs;
    this.objects = new Map(
      args.schedule.waves.flatMap(wave => wave.instances).map(instance => [instance.instanceId, new FruitObjectRuntime(instance)]),
    );
  }

  get hitCount(): number { return this.H; }
  get falseTouchCount(): number { return this.F; }
  get objectTouchCount(): number { return this.totalObjectTouches; }
  get blankTouchCount(): number { return this.blankTouches; }
  get duplicateTouchCount(): number { return this.duplicateTouches; }
  get isClosed(): boolean { return this.closedBatch !== null; }

  instanceRuntimes(): readonly FruitObjectRuntime[] { return [...this.objects.values()]; }

  advanceToSessionActive(activeMs: number): void {
    this.assertActiveMs(activeMs);
    if (activeMs < this.latestSessionActiveMs) throw new Error("batch active time moved backwards");
    this.latestSessionActiveMs = activeMs;
    const operationMs = Math.max(0, Math.min(OPERATION_DURATION_MS, activeMs - this.operationStartActiveMs));
    for (const object of this.objects.values()) object.advanceTo(operationMs);
  }

  touchInstance(instanceId: string, activeMs: number): TouchResult {
    if (this.closedBatch !== null) return IGNORED_PHASE;
    this.advanceToSessionActive(activeMs);
    this.totalObjectTouches += 1;
    if (activeMs < this.operationStartActiveMs || activeMs >= this.operationEndActiveMs) return IGNORED_PHASE;
    const object = this.objects.get(instanceId);
    if (object === undefined) return IGNORED_PHASE;
    const operationMs = activeMs - this.operationStartActiveMs;
    const result = object.touch(operationMs);
    this.H += result.hitDelta;
    this.F += result.falseTouchDelta;
    if (result.disposition === "IGNORED_SAME_TIMESTAMP" || result.disposition === "IGNORED_ALREADY_SETTLED") {
      this.duplicateTouches += 1;
    }
    return result;
  }

  touchBlank(activeMs: number): void {
    if (this.closedBatch !== null) return;
    this.advanceToSessionActive(activeMs);
    if (activeMs >= this.operationStartActiveMs && activeMs < this.operationEndActiveMs) this.blankTouches += 1;
  }

  close(activeMs: number): CatchLightEligibleBatch {
    if (this.closedBatch !== null) return this.closedBatch;
    if (activeMs !== this.closeAtActiveMs) throw new Error(`batch must close exactly at ${this.closeAtActiveMs}`);
    if (activeMs > SESSION_DURATION_MS) throw new Error("batch closed after the session deadline");
    this.advanceToSessionActive(activeMs);
    const audits = this.instanceAuditsAtOperationMs(OPERATION_DURATION_MS);
    const zone = resultZone(this.H, this.levelConfig.targetTotal, this.F, this.levelConfig.distractorTotal);
    const decision = applyLevelDecision(this.levelBefore, zone, this.consecutiveFailBefore);
    const metrics: BatchMetrics = {
      metricsVersion: "catch-light-batch-metrics-1",
      H: this.H,
      T: this.levelConfig.targetTotal,
      F: this.F,
      D: this.levelConfig.distractorTotal,
      targetFruitId: this.schedule.targetFruitId,
      backgroundId: this.schedule.backgroundId,
      configSetId: this.schedule.configSetId,
      generatorVersion: this.schedule.generatorVersion,
      difficultyStateId: this.levelConfig.difficultyStateId,
      timingProfile: this.levelConfig.timingBand,
      contentVariantId: this.levelConfig.contentVariantId,
      waveProfileId: this.levelConfig.waveProfileId,
      seedKey: this.levelConfig.seedKey,
      scheduleSha256: this.schedule.scheduleSha256,
      instanceAuditSha256: canonicalSha256(audits),
      targetTimeouts: audits.filter(audit => audit.role === "TARGET" && audit.outcome === "TIMEOUT").length,
      distractorAvoided: audits.filter(audit => audit.role === "DISTRACTOR" && audit.outcome === "AVOIDED").length,
      doubleTargets: audits.filter(audit => audit.role === "TARGET" && audit.isDouble).length,
      doubleCompleted: audits.filter(audit => audit.role === "TARGET" && audit.isDouble && audit.outcome === "HIT").length,
      doubleFirstOnly: audits.filter(audit => audit.role === "TARGET" && audit.isDouble && audit.firstTouchActiveMs !== null && audit.secondTouchActiveMs === null).length,
      totalObjectTouches: this.totalObjectTouches,
      blankTouches: this.blankTouches,
      duplicateTouches: this.duplicateTouches,
      consecutiveFailBefore: this.consecutiveFailBefore,
      consecutiveFailAfter: decision.consecutiveFailAfter,
    };
    const projection: Omit<CatchLightEligibleBatch, "batchPayloadSha256"> = {
      batchOrdinal: this.batchOrdinal,
      closed: true,
      decisionEligible: true,
      levelBefore: this.levelBefore,
      resultZone: decision.resultZone,
      levelTransition: decision.levelTransition,
      levelAfter: decision.levelAfter,
      batchScore: batchScore(this.H, this.levelConfig.targetTotal, this.F, this.levelConfig.distractorTotal, zone),
      closedAtActiveMs: activeMs,
      gameBatchMetrics: metrics,
    };
    this.closedBatch = {...projection, batchPayloadSha256: canonicalSha256(projection)};
    return this.closedBatch;
  }

  partialMetricsAt(cutoffActiveMs: number): PartialBatchMetrics {
    this.assertActiveMs(cutoffActiveMs);
    this.advanceToSessionActive(cutoffActiveMs);
    const relative = cutoffActiveMs - this.batchStartActiveMs;
    const phase: PartialBatchMetrics["phase"] = relative < PROMPT_DURATION_MS
      ? "PROMPT"
      : relative < PROMPT_DURATION_MS + OPERATION_DURATION_MS
        ? "OPERATION"
        : relative < PROMPT_DURATION_MS + OPERATION_DURATION_MS + FEEDBACK_DURATION_MS
          ? "FEEDBACK"
          : "TRANSITION";
    const operationMs = Math.max(0, Math.min(OPERATION_DURATION_MS, cutoffActiveMs - this.operationStartActiveMs));
    const audits = this.instanceAuditsAtOperationMs(operationMs);
    const presented = this.schedule.waves.flatMap(wave => wave.instances).filter(instance => instance.activeStartMs <= operationMs);
    const presentedIds = new Set(presented.map(instance => instance.instanceId));
    const waveOrdinal = operationMs < this.levelConfig.firstWaveMs
      ? 0
      : Math.min(this.levelConfig.waveCount, Math.floor((operationMs - this.levelConfig.firstWaveMs) / this.levelConfig.waveSpacingMs) + 1);
    return {
      metricsVersion: "catch-light-partial-metrics-1",
      phase,
      waveOrdinal,
      presentedTargetCount: presented.filter(instance => instance.role === "TARGET").length,
      presentedDistractorCount: presented.filter(instance => instance.role === "DISTRACTOR").length,
      H: this.H,
      F: this.F,
      unresolvedTargetCount: audits.filter(audit => presentedIds.has(audit.instanceId) && audit.role === "TARGET" && audit.outcome === "UNRESOLVED").length,
      totalObjectTouches: this.totalObjectTouches,
      blankTouches: this.blankTouches,
      scheduleSha256: this.schedule.scheduleSha256,
      instanceAuditSha256: canonicalSha256(audits),
    };
  }

  private instanceAuditsAtOperationMs(operationMs: number): InstanceAudit[] {
    return [...this.objects.values()]
      .map(object => object.auditAt(operationMs))
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }

  private assertActiveMs(value: number): void {
    if (!Number.isSafeInteger(value) || value < this.batchStartActiveMs) throw new Error("activeMs is before this batch or is not a safe integer");
  }
}

if (PROMPT_DURATION_MS + OPERATION_DURATION_MS + FEEDBACK_DURATION_MS + TRANSITION_DURATION_MS !== BATCH_DURATION_MS) {
  throw new Error("catch-light batch phase durations do not sum to 37500ms");
}
