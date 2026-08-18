import type { A620TrainingGameModule, PrepareContext } from "../../game-plugin.js";
import type { GameResultDraft } from "../../contracts.js";
import { ActiveLogicalClock } from "./logical-clock.js";
import { parseStrictGameConfig } from "./config.js";
import { immutableSnapshot } from "./immutability.js";
import { CatchLightSession } from "./session-engine.js";
import {
  CATCH_LIGHT_RUNTIME_SLICE_LEVELS,
  SESSION_DURATION_MS,
  type CatchLightEligibleBatch,
  type CatchLightGameConfig,
  type CatchLightSessionSnapshot,
  type TouchResult,
} from "./types.js";

export interface CatchLightModuleHooks {
  onBatchClosed?: (batch: CatchLightEligibleBatch) => void;
  /** Game-private persisted guide state supplied by a host-side adapter. */
  previouslyIntroducedLevels?: readonly number[];
}

export type CatchLightModuleState =
  | "UNPREPARED"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "DEADLINE"
  | "TERMINATED"
  | "DISPOSED";

interface PreparedExecution {
  sessionSeed: number;
  sessionStartLevel: number;
  runtimeConfigHash: string;
  gameConfig: CatchLightGameConfig;
}

const IGNORED_INPUT: TouchResult = Object.freeze({
  disposition: "IGNORED_WRONG_INSTANCE_PHASE",
  changedStatistics: false,
  hitDelta: 0,
  falseTouchDelta: 0,
});

export class CatchLightGameModule implements A620TrainingGameModule {
  readonly gameCode = "CATCH_LIGHT";
  private readonly onBatchClosed: ((batch: CatchLightEligibleBatch) => void) | undefined;
  private readonly previouslyIntroducedLevels: readonly number[];
  private preparedExecution: PreparedExecution | null = null;
  private session: CatchLightSession | null = null;
  private clock: ActiveLogicalClock | null = null;
  private pauseStartedUptimeMs: number | null = null;
  private localState: CatchLightModuleState = "UNPREPARED";
  private deliveringBatchClosed = false;

  constructor(hooks: CatchLightModuleHooks = {}) {
    this.onBatchClosed = hooks.onBatchClosed;
    this.previouslyIntroducedLevels = Object.freeze([...(hooks.previouslyIntroducedLevels ?? [])]);
  }

  get moduleState(): CatchLightModuleState { return this.localState; }

  async prepare(context: PrepareContext): Promise<void> {
    this.assertNotInBatchClosedHook("prepare");
    if (this.localState !== "UNPREPARED" && this.localState !== "DISPOSED") {
      throw new Error(`prepare is illegal while module state is ${this.localState}`);
    }
    if (context.gameCode !== this.gameCode) throw new Error(`CatchLightGameModule cannot prepare ${context.gameCode}`);
    if (context.durationMs !== SESSION_DURATION_MS) throw new Error("Catch Light requires durationMs=300000");
    if (!Number.isSafeInteger(context.sessionSeed) || context.sessionSeed < 0) {
      throw new Error("sessionSeed must be a non-negative safe integer");
    }
    if (!(CATCH_LIGHT_RUNTIME_SLICE_LEVELS as readonly number[]).includes(context.sessionStartLevel)) {
      throw new Error(`sessionStartLevel ${context.sessionStartLevel} is not one of the released W2 runtime slices`);
    }
    if (!/^[0-9a-f]{64}$/.test(context.runtimeConfigHash)) {
      throw new Error("runtimeConfigHash must be lowercase SHA-256");
    }

    const gameConfig = parseStrictGameConfig(context.gameConfig);
    this.preparedExecution = immutableSnapshot({
      sessionSeed: context.sessionSeed,
      sessionStartLevel: context.sessionStartLevel,
      runtimeConfigHash: context.runtimeConfigHash,
      gameConfig,
    });
    this.session = null;
    this.clock = null;
    this.pauseStartedUptimeMs = null;
    this.localState = "READY";
  }

  onStart(effectiveStartUptimeMs: number, cutoffUptimeMs: number): void {
    this.assertNotInBatchClosedHook("START");
    this.requireState("START", "READY");
    const prepared = this.requirePreparedExecution();

    // Build into local variables first so a rejected START cannot leave a
    // half-created clock/session visible to later lifecycle commands.
    const clock = new ActiveLogicalClock();
    clock.start(effectiveStartUptimeMs, cutoffUptimeMs);
    const sessionOptions = {
      gameConfig: prepared.gameConfig,
      runtimeConfigHash: prepared.runtimeConfigHash,
      sessionSeed: prepared.sessionSeed,
      sessionStartLevel: prepared.sessionStartLevel,
      previouslyIntroducedLevels: this.previouslyIntroducedLevels,
    };
    const session = this.onBatchClosed === undefined
      ? new CatchLightSession(sessionOptions)
      : new CatchLightSession({...sessionOptions, onBatchClosed:batch => this.deliverBatchClosed(batch)});
    session.advanceToActive(0);

    this.clock = clock;
    this.session = session;
    this.pauseStartedUptimeMs = null;
    this.localState = "RUNNING";
  }

  onPause(effectivePauseUptimeMs: number): void {
    this.assertNotInBatchClosedHook("PAUSE");
    this.requireState("PAUSE", "RUNNING");
    const clock = this.requireClock();
    // Validate without mutation before the domain sees the boundary. A rejected
    // PAUSE therefore cannot close batches or consume logical time. If domain
    // evidence delivery fails, the clock remains RUNNING and the same boundary
    // can be retried after the sink is repaired.
    const active = clock.previewPause(effectivePauseUptimeMs);
    this.requireSession().advanceToActive(active);
    clock.pause(effectivePauseUptimeMs);
    this.pauseStartedUptimeMs = effectivePauseUptimeMs;
    this.localState = "PAUSED";
  }

  onResume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void {
    this.assertNotInBatchClosedHook("RESUME");
    this.requireState("RESUME", "PAUSED");
    const pauseStartedUptimeMs = this.pauseStartedUptimeMs;
    if (pauseStartedUptimeMs === null) throw new Error("PAUSED module has no recorded pause boundary");
    if (!Number.isSafeInteger(resumeInputEnabledUptimeMs) || resumeInputEnabledUptimeMs < pauseStartedUptimeMs) {
      throw new Error("resumeInputEnabledUptimeMs must not precede the pause");
    }
    const pausedDurationMs = resumeInputEnabledUptimeMs - pauseStartedUptimeMs;
    const clock = this.requireClock();
    const session = this.requireSession();
    // Preflight both owners before either mutates. Once both validations pass,
    // the synchronous commits below cannot leave clock/session half-resumed.
    clock.validateResume(resumeInputEnabledUptimeMs, cutoffUptimeMs);
    session.validatePauseInterval(pausedDurationMs);
    clock.resume(resumeInputEnabledUptimeMs, cutoffUptimeMs);
    session.recordPauseInterval(pausedDurationMs);
    this.pauseStartedUptimeMs = null;
    this.localState = "RUNNING";
  }

  onDeadline(cutoffUptimeMs: number): void {
    this.assertNotInBatchClosedHook("DEADLINE");
    if (this.localState === "TERMINATED") return;
    if (this.localState === "DEADLINE") {
      // Idempotent confirmation. This also retries an ordered BATCH_CLOSED
      // delivery that may have failed after the clock was already sealed.
      this.requireSession().retryPendingBatchNotifications();
      this.requireSession().deadline();
      return;
    }
    this.requireState("DEADLINE", "RUNNING");
    const active = this.requireClock().deadline(cutoffUptimeMs);
    this.localState = "DEADLINE"; // input remains locked even if evidence delivery throws
    if (active !== SESSION_DURATION_MS) {
      throw new Error(`controller deadline produced ${active} active ms instead of 300000`);
    }
    this.requireSession().deadline();
  }

  onTerminate(_: string): void {
    this.assertNotInBatchClosedHook("TERMINATE");
    if (this.localState === "DISPOSED" || this.localState === "UNPREPARED" || this.localState === "TERMINATED") return;
    this.localState = "TERMINATED";
    this.pauseStartedUptimeMs = null;
  }

  advanceToUptime(uptimeMs: number): number {
    this.assertNotInBatchClosedHook("advance");
    this.requireState("advance", "RUNNING");
    const active = this.requireClock().activeElapsedAt(uptimeMs);
    this.requireSession().advanceToActive(active);
    return active;
  }

  /**
   * Returns the last committed domain snapshot without advancing the logical
   * clock or closing a batch. Public v1.3 defines QUERY_STATE as non-mutating;
   * explicit frame/input paths must call advanceToUptime/touch instead.
   *
   * uptimeMs is validated only as request metadata. It deliberately does not
   * participate in monotonic-clock ownership, so a diagnostic query cannot
   * make a later PAUSE/RESUME boundary look like a rollback.
   */
  snapshotAtUptime(uptimeMs: number): CatchLightSessionSnapshot {
    this.assertNotInBatchClosedHook("snapshot");
    if (this.localState !== "RUNNING" && this.localState !== "PAUSED" && this.localState !== "DEADLINE") {
      throw new Error(`snapshot is illegal while module state is ${this.localState}`);
    }
    if (!Number.isSafeInteger(uptimeMs) || uptimeMs < 0) {
      throw new Error("snapshot uptimeMs must be a non-negative safe integer");
    }
    return this.requireSession().snapshot();
  }

  retryPendingBatchNotifications(): void {
    this.assertNotInBatchClosedHook("batch notification retry");
    if (this.localState === "UNPREPARED" || this.localState === "READY" || this.localState === "DISPOSED") {
      throw new Error(`batch notification retry is illegal while module state is ${this.localState}`);
    }
    this.requireSession().retryPendingBatchNotifications();
  }

  touchInstanceAtUptime(instanceId: string, uptimeMs: number): TouchResult {
    this.assertNotInBatchClosedHook("touch");
    if (this.localState === "PAUSED" || this.localState === "DEADLINE" || this.localState === "TERMINATED") return IGNORED_INPUT;
    this.requireState("touch", "RUNNING");
    const active = this.requireClock().activeElapsedAt(uptimeMs);
    return this.requireSession().touchInstance(instanceId, active);
  }

  touchBlankAtUptime(uptimeMs: number): void {
    this.assertNotInBatchClosedHook("blank touch");
    if (this.localState === "PAUSED" || this.localState === "DEADLINE" || this.localState === "TERMINATED") return;
    this.requireState("blank touch", "RUNNING");
    const active = this.requireClock().activeElapsedAt(uptimeMs);
    this.requireSession().touchBlank(active);
  }

  buildResultDraft(): GameResultDraft {
    this.assertNotInBatchClosedHook("buildResultDraft");
    this.requireState("buildResultDraft", "DEADLINE");
    const session = this.requireSession();
    // A DEADLINE callback may have sealed the clock and then failed while
    // delivering BATCH_CLOSED evidence. RESULT_READY construction is allowed
    // to resume that idempotent domain finalization after the sink is repaired;
    // it never recomputes an already committed batch.
    session.retryPendingBatchNotifications();
    session.deadline();
    return session.buildResultDraft();
  }

  async dispose(): Promise<void> {
    this.assertNotInBatchClosedHook("dispose");
    this.preparedExecution = null;
    this.session = null;
    this.clock = null;
    this.pauseStartedUptimeMs = null;
    this.localState = "DISPOSED";
  }

  private deliverBatchClosed(batch: CatchLightEligibleBatch): void {
    if (this.onBatchClosed === undefined) throw new Error("internal BATCH_CLOSED hook wiring error");
    if (this.deliveringBatchClosed) throw new Error("BATCH_CLOSED hook must not re-enter the Catch Light module");
    this.deliveringBatchClosed = true;
    try {
      this.onBatchClosed(batch);
    } finally {
      this.deliveringBatchClosed = false;
    }
  }

  private assertNotInBatchClosedHook(operation: string): void {
    if (this.deliveringBatchClosed) {
      throw new Error(`${operation} is forbidden during BATCH_CLOSED delivery`);
    }
  }

  private requireState(operation: string, expected: CatchLightModuleState): void {
    if (this.localState !== expected) {
      throw new Error(`${operation} requires module state ${expected}; current state is ${this.localState}`);
    }
  }

  private requirePreparedExecution(): PreparedExecution {
    if (this.preparedExecution === null) throw new Error("module has no prepared execution");
    return this.preparedExecution;
  }

  private requireClock(): ActiveLogicalClock {
    if (this.clock === null) throw new Error("module clock is not running");
    return this.clock;
  }

  private requireSession(): CatchLightSession {
    if (this.session === null) throw new Error("module session is not running");
    return this.session;
  }
}
