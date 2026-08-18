import { canonicalSha256 } from "../../canonical.js";
import { FruitObjectRuntime } from "./object-machine.js";
import { immutableSnapshot } from "./immutability.js";
import { validateGeneratedSchedule } from "./generator.js";
import { applyLevelDecision, batchScore, resultZone } from "./scoring.js";
import {
  BATCH_DURATION_MS,
  FEEDBACK_DURATION_MS,
  OPERATION_DURATION_MS,
  PROMPT_DURATION_MS,
  SESSION_DURATION_MS,
  TRANSITION_DURATION_MS,
  type BatchMetrics,
  type CatchLightBatchPhase,
  type CatchLightBatchSnapshot,
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
  private sealedAtActiveMs: number | null = null;

  constructor(args: {
    batchOrdinal: number;
    batchStartActiveMs: number;
    levelBefore: number;
    consecutiveFailBefore: 0 | 1;
    levelConfig: CatchLightLevelConfig;
    schedule: GeneratedBatchSchedule;
  }) {
    if (!Number.isSafeInteger(args.batchOrdinal) || args.batchOrdinal < 1 || args.batchOrdinal > 8) {
      throw new Error("batchOrdinal must be in 1..8");
    }
    if (!Number.isSafeInteger(args.batchStartActiveMs) || args.batchStartActiveMs < 0) {
      throw new Error("batchStartActiveMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(args.levelBefore) || args.levelBefore < 1 || args.levelBefore > 120) {
      throw new Error("levelBefore must be in 1..120");
    }
    if (args.consecutiveFailBefore !== 0 && args.consecutiveFailBefore !== 1) {
      throw new Error("consecutiveFailBefore must be 0 or 1");
    }
    this.batchOrdinal = args.batchOrdinal;
    this.batchStartActiveMs = args.batchStartActiveMs;
    this.operationStartActiveMs = args.batchStartActiveMs + PROMPT_DURATION_MS;
    this.operationEndActiveMs = this.operationStartActiveMs + OPERATION_DURATION_MS;
    this.closeAtActiveMs = args.batchStartActiveMs + BATCH_DURATION_MS;
    this.levelBefore = args.levelBefore;
    this.consecutiveFailBefore = args.consecutiveFailBefore;
    this.levelConfig = immutableSnapshot(args.levelConfig);
    this.schedule = immutableSnapshot(args.schedule);
    if (this.levelConfig.level !== this.levelBefore) throw new Error("levelBefore differs from levelConfig.level");
    if (this.schedule.batchOrdinal !== this.batchOrdinal) throw new Error("schedule batchOrdinal mismatch");
    validateGeneratedSchedule(this.schedule, this.levelConfig);
    this.latestSessionActiveMs = args.batchStartActiveMs;
    this.objects = new Map(
      this.schedule.waves.flatMap(wave => wave.instances).map(instance => [instance.instanceId, new FruitObjectRuntime(instance)]),
    );
  }

  get hitCount(): number { return this.H; }
  get falseTouchCount(): number { return this.F; }
  get objectTouchCount(): number { return this.totalObjectTouches; }
  get blankTouchCount(): number { return this.blankTouches; }
  get duplicateTouchCount(): number { return this.duplicateTouches; }
  get isClosed(): boolean { return this.closedBatch !== null; }

  advanceToSessionActive(activeMs: number): void {
    this.assertActiveMs(activeMs);
    if (activeMs < this.latestSessionActiveMs) throw new Error("batch active time moved backwards");
    if (this.sealedAtActiveMs !== null && activeMs > this.sealedAtActiveMs) throw new Error("batch cannot advance beyond its authoritative cutoff");
    this.latestSessionActiveMs = activeMs;
    const operationMs = Math.max(0, Math.min(OPERATION_DURATION_MS, activeMs - this.operationStartActiveMs));
    for (const object of this.objects.values()) object.advanceTo(operationMs);
  }

  snapshotAt(activeMs: number): CatchLightBatchSnapshot {
    this.advanceToSessionActive(activeMs);
    const phase = this.phaseAt(activeMs);
    const operationElapsedMs = Math.max(0, Math.min(OPERATION_DURATION_MS, activeMs - this.operationStartActiveMs));
    const currentWaveOrdinal = operationElapsedMs < this.levelConfig.firstWaveMs
      ? 0
      : Math.min(this.levelConfig.waveCount, Math.floor((operationElapsedMs - this.levelConfig.firstWaveMs) / this.levelConfig.waveSpacingMs) + 1);
    const visibleObjects = [...this.objects.values()]
      .map(object => object.presentationSnapshotAt(operationElapsedMs))
      .filter(snapshot => snapshot.visualPhase !== "HIDDEN" && snapshot.visualPhase !== "GONE");
    return immutableSnapshot({
      batchOrdinal: this.batchOrdinal,
      levelBefore: this.levelBefore,
      batchStartActiveMs: this.batchStartActiveMs,
      phase,
      operationElapsedMs,
      currentWaveOrdinal,
      targetFruitId: this.schedule.targetFruitId,
      backgroundId: this.schedule.backgroundId,
      gridId: this.schedule.gridId,
      H: this.H,
      F: this.F,
      visibleObjects,
    });
  }

  phaseAt(activeMs: number): CatchLightBatchPhase {
    this.assertActiveMs(activeMs);
    if (this.closedBatch !== null || activeMs >= this.closeAtActiveMs) return "CLOSED";
    const relativeMs = activeMs - this.batchStartActiveMs;
    if (relativeMs < PROMPT_DURATION_MS) return "PROMPT";
    if (relativeMs < PROMPT_DURATION_MS + OPERATION_DURATION_MS) return "OPERATION";
    if (relativeMs < PROMPT_DURATION_MS + OPERATION_DURATION_MS + FEEDBACK_DURATION_MS) return "FEEDBACK";
    return "TRANSITION";
  }

  touchInstance(instanceId: string, activeMs: number): TouchResult {
    if (this.closedBatch !== null || this.sealedAtActiveMs !== null) return IGNORED_PHASE;
    this.advanceToSessionActive(activeMs);
    if (activeMs < this.operationStartActiveMs || activeMs >= this.operationEndActiveMs) return IGNORED_PHASE;
    const object = this.objects.get(instanceId);
    if (object === undefined) return IGNORED_PHASE;
    this.totalObjectTouches += 1;
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
    if (this.closedBatch !== null || this.sealedAtActiveMs !== null) return;
    this.advanceToSessionActive(activeMs);
    if (activeMs >= this.operationStartActiveMs && activeMs < this.operationEndActiveMs) this.blankTouches += 1;
  }

  close(activeMs: number): CatchLightEligibleBatch {
    if (this.closedBatch !== null) return this.closedBatch;
    if (this.sealedAtActiveMs !== null) throw new Error("incomplete batch cannot be closed after authoritative cutoff sealing");
    if (activeMs !== this.closeAtActiveMs) throw new Error(`batch must close exactly at ${this.closeAtActiveMs}`);
    if (activeMs > SESSION_DURATION_MS) throw new Error("batch closed after the session deadline");
    this.advanceToSessionActive(activeMs);
    const audits = this.instanceAuditsAtOperationMs(OPERATION_DURATION_MS);
    const zone = resultZone(this.H, this.levelConfig.targetTotal, this.F, this.levelConfig.distractorTotal);
    const decision = applyLevelDecision(this.levelBefore, zone, this.consecutiveFailBefore);
    const metrics: BatchMetrics = {
      metricsVersion: "catch-light-batch-metrics-2",
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
      firstTeachingBatchWaveOneDoubleSuppressed: this.schedule.firstTeachingBatchWaveOneDoubleSuppressed,
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
    const closed = immutableSnapshot({...projection, batchPayloadSha256: canonicalSha256(projection)});
    this.closedBatch = closed;
    return closed;
  }

  sealIncompleteAt(cutoffActiveMs: number): PartialBatchMetrics {
    if (this.closedBatch !== null) throw new Error("closed batch cannot be sealed as incomplete");
    if (cutoffActiveMs >= this.closeAtActiveMs) throw new Error("an incomplete cutoff must precede the formal batch close time");
    if (this.sealedAtActiveMs !== null) {
      if (cutoffActiveMs !== this.sealedAtActiveMs) throw new Error("incomplete batch cutoff cannot change after sealing");
      return this.partialMetricsAt(cutoffActiveMs);
    }
    this.advanceToSessionActive(cutoffActiveMs);
    this.sealedAtActiveMs = cutoffActiveMs;
    return this.partialMetricsAt(cutoffActiveMs);
  }

  partialMetricsAt(cutoffActiveMs: number): PartialBatchMetrics {
    if (this.closedBatch !== null) throw new Error("closed batch cannot emit partial metrics");
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
    const presentedAudits = audits.filter(audit => presentedIds.has(audit.instanceId));
    const waveOrdinal = operationMs < this.levelConfig.firstWaveMs
      ? 0
      : Math.min(this.levelConfig.waveCount, Math.floor((operationMs - this.levelConfig.firstWaveMs) / this.levelConfig.waveSpacingMs) + 1);
    const partial = {
      metricsVersion: "catch-light-partial-metrics-2",
      phase,
      waveOrdinal,
      presentedTargetCount: presented.filter(instance => instance.role === "TARGET").length,
      presentedDistractorCount: presented.filter(instance => instance.role === "DISTRACTOR").length,
      H: this.H,
      F: this.F,
      unresolvedTargetCount: presentedAudits.filter(audit => audit.role === "TARGET" && audit.outcome === "UNRESOLVED").length,
      totalObjectTouches: this.totalObjectTouches,
      blankTouches: this.blankTouches,
      duplicateTouches: this.duplicateTouches,
      scheduleSha256: this.schedule.scheduleSha256,
      firstTeachingBatchWaveOneDoubleSuppressed: this.schedule.firstTeachingBatchWaveOneDoubleSuppressed,
      instanceAuditSha256: canonicalSha256(presentedAudits),
    } satisfies PartialBatchMetrics;
    return immutableSnapshot(partial);
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
