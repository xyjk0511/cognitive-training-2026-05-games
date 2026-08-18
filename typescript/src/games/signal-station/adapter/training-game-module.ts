import { canonicalSha256 } from "../../../canonical.js";
import type { GameResultDraft } from "../../../contracts.js";
import type { A620TrainingGameModule, PrepareContext } from "../../../game-plugin.js";
import { BATCH_DURATION_MS, SESSION_DURATION_MS, SIGNAL_STATION_GAME_CODE } from "../constants.js";
import { VERTICAL_SLICE_RUNTIME_CONFIG, validateRuntimeConfig } from "../config/vertical-slices.js";
import { DeterministicActiveClock } from "../domain/logical-clock.js";
import { SignalStationSession } from "../domain/session.js";
import type { GeneratedBatchPlan, TouchResult } from "../types.js";

function asRuntimeConfig(value: Readonly<Record<string, unknown>>): typeof VERTICAL_SLICE_RUNTIME_CONFIG {
  if (value === null || Array.isArray(value)) throw new Error("gameConfig must be an object");
  const candidate = value as unknown as typeof VERTICAL_SLICE_RUNTIME_CONFIG;
  validateRuntimeConfig(candidate);
  return candidate;
}

/** Game-local implementation of the frozen public SPI; shared game-plugin.ts remains untouched. */
export class SignalStationTrainingGameModule implements A620TrainingGameModule {
  readonly gameCode = SIGNAL_STATION_GAME_CODE;
  private context: PrepareContext | null = null;
  private session: SignalStationSession | null = null;
  private clock: DeterministicActiveClock | null = null;
  private terminated = false;

  async prepare(context: PrepareContext): Promise<void> {
    if (context.gameCode !== SIGNAL_STATION_GAME_CODE) throw new Error("PREPARE gameCode mismatch");
    if (context.durationMs !== SESSION_DURATION_MS) throw new Error("Signal Station duration must be 300000ms");
    const config = asRuntimeConfig(context.gameConfig);
    const calculatedHash = canonicalSha256(config);
    if (context.runtimeConfigHash !== calculatedHash) throw new Error("runtimeConfigHash does not match canonical gameConfig");
    const frozenVerticalSliceHash = canonicalSha256(VERTICAL_SLICE_RUNTIME_CONFIG);
    if (calculatedHash !== frozenVerticalSliceHash) throw new Error("gameConfig is not the frozen six-slice runtime config");
    this.context = context;
    this.session = new SignalStationSession({
      sessionSeed: context.sessionSeed,
      sessionStartLevel: context.sessionStartLevel,
      runtimeConfigHash: context.runtimeConfigHash,
    });
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
    this.terminated = true;
    this.requireSession().terminate();
    this.requireClock().terminate();
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
    const activeMs = clock.advanceTo(sourceUptimeMs);
    while (true) {
      const closed = session.advanceTo(activeMs);
      if (closed === null) break;
      if (session.eligibleBatchCount >= 8) break;
      const nextStart = session.eligibleBatchCount * BATCH_DURATION_MS;
      if (nextStart >= SESSION_DURATION_MS || nextStart > activeMs) break;
      session.startBatch(nextStart);
    }
  }

  onPointerDown(instanceId: string | null, pointerEventId: string, sourceUptimeMs: number): TouchResult {
    const clock = this.requireClock();
    if (!clock.canAcceptInputAt(sourceUptimeMs)) {
      return Object.freeze({disposition: "IGNORED_OUTSIDE_WINDOW", instanceId, stateAfter: null, hitDelta: 0, falseTouchDelta: 0});
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

  private requireSession(): SignalStationSession {
    if (this.session === null) throw new Error("module has not been prepared");
    return this.session;
  }

  private requireClock(): DeterministicActiveClock {
    if (this.clock === null) throw new Error("module has not been prepared");
    return this.clock;
  }
}
