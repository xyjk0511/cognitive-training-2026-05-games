import { canonicalSha256 } from "../../../canonical.js";
import type { GameResultDraft } from "../../../contracts.js";
import {
  TrainingPointerEventGate,
  type A620InteractiveTrainingGameModule,
  type BatchEvidenceSink,
  type InputStreamCancellationReason,
  type PrepareContext,
  type TrainingPointerEvent,
} from "../../../game-plugin.js";
import { SESSION_DURATION_MS, SIGNAL_STATION_GAME_CODE } from "../constants.js";
import {
  isVerticalSliceLevelImplemented, VERTICAL_SLICE_RUNTIME_CONFIG, validateRuntimeConfig,
} from "../config/vertical-slices.js";
import { DeterministicActiveClock } from "../domain/logical-clock.js";
import { SignalStationSession } from "../domain/session.js";
import type {
  GeneratedBatchPlan, TouchResult, VerticalSliceCoverageBlock,
} from "../types.js";

function asRuntimeConfig(value: Readonly<Record<string, unknown>>): typeof VERTICAL_SLICE_RUNTIME_CONFIG {
  validateRuntimeConfig(value);
  return value;
}

/** Game-local implementation of the lifecycle SPI and host-only interactive companion SPI. */
export class SignalStationTrainingGameModule implements A620InteractiveTrainingGameModule {
  readonly gameCode = SIGNAL_STATION_GAME_CODE;
  private context: PrepareContext | null = null;
  private session: SignalStationSession | null = null;
  private clock: DeterministicActiveClock | null = null;
  private evidenceSink: BatchEvidenceSink | undefined;
  private readonly inputGate = new TrainingPointerEventGate();
  private deliveringBatchEvidence = false;
  private terminated = false;

  setEvidenceSink(sink: BatchEvidenceSink): void {
    this.assertNotDeliveringBatchEvidence("setEvidenceSink");
    if (typeof sink !== "function") throw new Error("evidence sink must be a function");
    this.evidenceSink = sink;
  }

  async prepare(context: PrepareContext): Promise<void> {
    this.assertNotDeliveringBatchEvidence("prepare");
    if (this.context !== null || this.session !== null || this.clock !== null) {
      throw new Error("module is already prepared; dispose it before preparing another execution");
    }
    if (context.gameCode !== SIGNAL_STATION_GAME_CODE) throw new Error("PREPARE gameCode mismatch");
    if (context.durationMs !== SESSION_DURATION_MS) throw new Error("Signal Station duration must be 300000ms");
    const config = asRuntimeConfig(context.gameConfig);
    const calculatedHash = canonicalSha256(config);
    if (context.runtimeConfigHash !== calculatedHash) throw new Error("runtimeConfigHash does not match canonical gameConfig");
    const frozenVerticalSliceHash = canonicalSha256(VERTICAL_SLICE_RUNTIME_CONFIG);
    if (calculatedHash !== frozenVerticalSliceHash) throw new Error("gameConfig is not the frozen six-slice runtime config");

    const session = new SignalStationSession({
      sessionSeed: context.sessionSeed,
      sessionStartLevel: context.sessionStartLevel,
      runtimeConfigHash: context.runtimeConfigHash,
    });
    this.context = context;
    this.session = session;
    this.clock = new DeterministicActiveClock();
    this.inputGate.reset();
    this.terminated = false;
  }

  onStart(effectiveStartUptimeMs: number, cutoffUptimeMs: number): void {
    this.assertNotDeliveringBatchEvidence("START");
    const clock = this.requireClock();
    const session = this.requireSession();
    clock.startAt(effectiveStartUptimeMs, cutoffUptimeMs);
    session.startBatch(0);
  }

  onPause(effectivePauseUptimeMs: number): void {
    this.assertNotDeliveringBatchEvidence("PAUSE");
    const clock = this.requireClock();
    this.advanceToUptimeMs(effectivePauseUptimeMs);
    this.flushPendingBatchEvidence();
    clock.pauseAt(effectivePauseUptimeMs);
  }

  onResume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void {
    this.assertNotDeliveringBatchEvidence("RESUME");
    const clock = this.requireClock();
    const pausedDuration = clock.resumeAt(resumeInputEnabledUptimeMs, cutoffUptimeMs);
    this.requireSession().recordPause(pausedDuration);
  }

  onDeadline(cutoffUptimeMs: number): void {
    this.assertNotDeliveringBatchEvidence("DEADLINE");
    const clock = this.requireClock();
    const session = this.requireSession();
    if (this.evidenceSink !== undefined &&
        (session.currentActiveMs !== SESSION_DURATION_MS || session.drainClosedBatchDrafts().length !== 0)) {
      throw new Error("interactive host must advance and persist BATCH_CLOSED before DEADLINE");
    }
    this.advanceToUptimeMs(cutoffUptimeMs);
    clock.reachDeadlineAt(cutoffUptimeMs);
    session.deadline();
  }

  onTerminate(_: string): void {
    this.assertNotDeliveringBatchEvidence("TERMINATE");
    if (this.terminated) throw new Error("execution is already terminated");
    const session = this.requireSession();
    const clock = this.requireClock();
    session.terminate();
    clock.terminate();
    this.terminated = true;
  }

  buildResultDraft(): GameResultDraft {
    this.assertNotDeliveringBatchEvidence("buildResultDraft");
    if (this.terminated) throw new Error("terminated execution has no GameResultDraft");
    const session = this.requireSession();
    if (this.evidenceSink !== undefined && session.drainClosedBatchDrafts().length !== 0) {
      throw new Error("interactive host must persist BATCH_CLOSED before RESULT_READY");
    }
    return session.buildResultDraft();
  }

  async dispose(): Promise<void> {
    this.assertNotDeliveringBatchEvidence("dispose");
    this.context = null;
    this.session = null;
    this.clock = null;
    this.inputGate.reset();
    this.terminated = false;
  }

  advanceToUptimeMs(sourceUptimeMs: number): void {
    this.assertNotDeliveringBatchEvidence("advance");
    const clock = this.requireClock();
    const session = this.requireSession();
    const targetActiveMs = clock.advanceTo(sourceUptimeMs);

    while (true) {
      const batch = session.currentBatch;
      if (batch === null || targetActiveMs < batch.batchEndActiveMs) {
        session.advanceTo(targetActiveMs);
        return;
      }

      // A source-time jump can cross several fixed batch boundaries. Close each
      // batch at its own boundary before opening the next one; never advance the
      // session to the final target and then try to create a batch in its past.
      const closed = session.advanceTo(batch.batchEndActiveMs);
      if (closed === null) throw new Error("batch boundary was reached without closing the active batch");

      if (!isVerticalSliceLevelImplemented(session.currentLevel)) {
        session.markVerticalSliceCoverageBlocked();
        if (session.currentActiveMs < targetActiveMs) session.advanceTo(targetActiveMs);
        return;
      }
      if (session.eligibleBatchCount >= 8 || closed.closedAtActiveMs >= SESSION_DURATION_MS) {
        if (session.currentActiveMs < targetActiveMs) session.advanceTo(targetActiveMs);
        return;
      }

      session.startBatch(closed.closedAtActiveMs);
    }
  }

  advanceToUptime(sourceUptimeMs: number): number {
    this.advanceToUptimeMs(sourceUptimeMs);
    this.flushPendingBatchEvidence();
    return this.requireClock().activeElapsedMs;
  }

  onPointerDown(instanceId: string | null, pointerEventId: string, sourceUptimeMs: number): TouchResult {
    this.assertNotDeliveringBatchEvidence("pointer input");
    if (typeof pointerEventId !== "string" || pointerEventId.length === 0) {
      throw new Error("pointerEventId must not be empty");
    }
    const clock = this.requireClock();
    if (!clock.canAcceptInputAt(sourceUptimeMs)) {
      return Object.freeze({
        disposition: "IGNORED_OUTSIDE_WINDOW",
        instanceId,
        stateAfter: null,
        hitDelta: 0,
        falseTouchDelta: 0,
      });
    }
    const activeMs = clock.activeElapsedMs;
    this.advanceToUptimeMs(sourceUptimeMs);
    this.flushPendingBatchEvidence();
    return this.requireSession().touch(instanceId, activeMs, pointerEventId);
  }

  onPointerEvent(event: Readonly<TrainingPointerEvent>): void {
    this.assertNotDeliveringBatchEvidence("pointer event");
    if (this.inputGate.accept(event) !== "DOWN") return;
    try {
      this.onPointerDown(event.hitToken, event.pointerEventId, event.sourceUptimeMs);
    } catch (error) {
      this.inputGate.rollbackDown(event);
      throw error;
    }
  }

  onInputStreamsCancelled(reason: InputStreamCancellationReason): void {
    this.assertNotDeliveringBatchEvidence("input stream cancellation");
    this.inputGate.cancelAll(reason);
  }

  retryPendingBatchEvidence(): void {
    this.assertNotDeliveringBatchEvidence("batch evidence retry");
    this.flushPendingBatchEvidence();
  }

  drainBatchClosedDrafts() {
    this.assertNotDeliveringBatchEvidence("batch evidence read");
    return this.requireSession().drainClosedBatchDrafts();
  }

  acknowledgeBatchClosedDraft(batchPayloadSha256: string): void {
    this.assertNotDeliveringBatchEvidence("batch evidence acknowledgement");
    this.requireSession().acknowledgeClosedBatchDraft(batchPayloadSha256);
  }

  currentPlan(): GeneratedBatchPlan | null {
    return this.requireSession().currentBatch?.plan ?? null;
  }

  coverageBlock(): VerticalSliceCoverageBlock | null {
    return this.requireSession().coverageBlock;
  }

  private flushPendingBatchEvidence(): void {
    const sink = this.evidenceSink;
    if (sink === undefined) return;
    if (this.deliveringBatchEvidence) throw new Error("BATCH_CLOSED sink must not re-enter Signal Station");

    while (true) {
      const batch = this.requireSession().drainClosedBatchDrafts()[0];
      if (batch === undefined) return;
      this.deliveringBatchEvidence = true;
      try {
        sink(batch);
      } finally {
        this.deliveringBatchEvidence = false;
      }
      this.requireSession().acknowledgeClosedBatchDraft(batch.batchPayloadSha256);
    }
  }

  private assertNotDeliveringBatchEvidence(operation: string): void {
    if (this.deliveringBatchEvidence) throw new Error(`${operation} is forbidden during BATCH_CLOSED delivery`);
  }

  private requireSession(): SignalStationSession {
    if (this.session === null) throw new Error("module has not been prepared");
    return this.session;
  }

  private requireClock(): DeterministicActiveClock {
    if (this.clock === null) throw new Error("module has not been prepared");
    return this.clock;
  }
}
