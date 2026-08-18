import { canonicalSha256 } from "../../../canonical.js";
import type { GameResultDraft } from "../../../contracts.js";
import type { A620TrainingGameModule, PrepareContext } from "../../../game-plugin.js";
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

/** Game-local implementation of the frozen public SPI; shared game-plugin.ts remains untouched. */
export class SignalStationTrainingGameModule implements A620TrainingGameModule {
  readonly gameCode = SIGNAL_STATION_GAME_CODE;
  private context: PrepareContext | null = null;
  private session: SignalStationSession | null = null;
  private clock: DeterministicActiveClock | null = null;
  private terminated = false;

  async prepare(context: PrepareContext): Promise<void> {
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
    this.terminated = false;
  }

  onStart(effectiveStartUptimeMs: number, cutoffUptimeMs: number): void {
    const clock = this.requireClock();
    const session = this.requireSession();
    clock.startAt(effectiveStartUptimeMs, cutoffUptimeMs);
    session.startBatch(0);
  }

  onPause(effectivePauseUptimeMs: number): void {
    const clock = this.requireClock();
    this.advanceToUptimeMs(effectivePauseUptimeMs);
    clock.pauseAt(effectivePauseUptimeMs);
  }

  onResume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void {
    const clock = this.requireClock();
    const pausedDuration = clock.resumeAt(resumeInputEnabledUptimeMs, cutoffUptimeMs);
    this.requireSession().recordPause(pausedDuration);
  }

  onDeadline(cutoffUptimeMs: number): void {
    const clock = this.requireClock();
    this.advanceToUptimeMs(cutoffUptimeMs);
    clock.reachDeadlineAt(cutoffUptimeMs);
    this.requireSession().deadline();
  }

  onTerminate(_: string): void {
    if (this.terminated) throw new Error("execution is already terminated");
    const session = this.requireSession();
    const clock = this.requireClock();
    session.terminate();
    clock.terminate();
    this.terminated = true;
  }

  buildResultDraft(): GameResultDraft {
    if (this.terminated) throw new Error("terminated execution has no GameResultDraft");
    return this.requireSession().buildResultDraft();
  }

  async dispose(): Promise<void> {
    this.context = null;
    this.session = null;
    this.clock = null;
    this.terminated = false;
  }

  advanceToUptimeMs(sourceUptimeMs: number): void {
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

  onPointerDown(instanceId: string | null, pointerEventId: string, sourceUptimeMs: number): TouchResult {
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
    return this.requireSession().touch(instanceId, activeMs, pointerEventId);
  }

  drainBatchClosedDrafts() {
    return this.requireSession().drainClosedBatchDrafts();
  }

  currentPlan(): GeneratedBatchPlan | null {
    return this.requireSession().currentBatch?.plan ?? null;
  }

  coverageBlock(): VerticalSliceCoverageBlock | null {
    return this.requireSession().coverageBlock;
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
