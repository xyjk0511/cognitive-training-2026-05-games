import type { A620TrainingGameModule, PrepareContext } from "../../game-plugin.js";
import type { GameResultDraft } from "../../contracts.js";
import { ActiveLogicalClock } from "./logical-clock.js";
import { parseStrictGameConfig } from "./config.js";
import { CatchLightSession } from "./session-engine.js";
import { SESSION_DURATION_MS, type CatchLightEligibleBatch, type TouchResult } from "./types.js";

export interface CatchLightModuleHooks {
  onBatchClosed?: (batch: CatchLightEligibleBatch) => void;
}

export class CatchLightGameModule implements A620TrainingGameModule {
  readonly gameCode = "CATCH_LIGHT";
  private readonly hooks: CatchLightModuleHooks;
  private preparedContext: PrepareContext | null = null;
  private session: CatchLightSession | null = null;
  private clock: ActiveLogicalClock | null = null;
  private pauseStartedUptimeMs: number | null = null;
  private terminated = false;

  constructor(hooks: CatchLightModuleHooks = {}) {
    this.hooks = hooks;
  }

  async prepare(context: PrepareContext): Promise<void> {
    if (context.gameCode !== this.gameCode) throw new Error(`CatchLightGameModule cannot prepare ${context.gameCode}`);
    if (context.durationMs !== SESSION_DURATION_MS) throw new Error("Catch Light requires durationMs=300000");
    parseStrictGameConfig(context.gameConfig);
    this.preparedContext = context;
    this.session = null;
    this.clock = null;
    this.pauseStartedUptimeMs = null;
    this.terminated = false;
  }

  onStart(effectiveStartUptimeMs: number, cutoffUptimeMs: number): void {
    if (this.preparedContext === null) throw new Error("prepare must complete before start");
    const config = parseStrictGameConfig(this.preparedContext.gameConfig);
    this.clock = new ActiveLogicalClock();
    this.clock.start(effectiveStartUptimeMs, cutoffUptimeMs);
    this.pauseStartedUptimeMs = null;
    const sessionOptions = {
      gameConfig: config,
      runtimeConfigHash: this.preparedContext.runtimeConfigHash,
      sessionSeed: this.preparedContext.sessionSeed,
      sessionStartLevel: this.preparedContext.sessionStartLevel,
    };
    this.session = this.hooks.onBatchClosed === undefined
      ? new CatchLightSession(sessionOptions)
      : new CatchLightSession({...sessionOptions, onBatchClosed:this.hooks.onBatchClosed});
    this.session.advanceToActive(0);
  }

  onPause(effectivePauseUptimeMs: number): void {
    if (this.pauseStartedUptimeMs !== null) throw new Error("pause is already active");
    const active = this.requireClock().pause(effectivePauseUptimeMs);
    this.requireSession().advanceToActive(active);
    this.pauseStartedUptimeMs = effectivePauseUptimeMs;
  }

  onResume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void {
    const pauseStartedUptimeMs = this.pauseStartedUptimeMs;
    if (pauseStartedUptimeMs === null) throw new Error("resume requires a recorded pause");
    if (!Number.isSafeInteger(resumeInputEnabledUptimeMs) || resumeInputEnabledUptimeMs < pauseStartedUptimeMs) {
      throw new Error("resumeInputEnabledUptimeMs must not precede the pause");
    }
    this.requireClock().resume(resumeInputEnabledUptimeMs, cutoffUptimeMs);
    this.requireSession().recordPauseInterval(resumeInputEnabledUptimeMs - pauseStartedUptimeMs);
    this.pauseStartedUptimeMs = null;
  }

  onDeadline(cutoffUptimeMs: number): void {
    if (this.terminated) return;
    const active = this.requireClock().deadline(cutoffUptimeMs);
    if (active !== SESSION_DURATION_MS) throw new Error(`controller deadline produced ${active} active ms instead of 300000`);
    this.requireSession().deadline();
  }

  onTerminate(_: string): void {
    this.terminated = true;
  }

  advanceToUptime(uptimeMs: number): number {
    const active = this.requireClock().activeElapsedAt(uptimeMs);
    this.requireSession().advanceToActive(active);
    return active;
  }

  touchInstanceAtUptime(instanceId: string, uptimeMs: number): TouchResult {
    if (this.terminated || this.requireClock().state === "PAUSED") return {disposition:"IGNORED_WRONG_INSTANCE_PHASE",changedStatistics:false,hitDelta:0,falseTouchDelta:0};
    const active = this.requireClock().activeElapsedAt(uptimeMs);
    return this.requireSession().touchInstance(instanceId, active);
  }

  touchBlankAtUptime(uptimeMs: number): void {
    if (this.terminated || this.requireClock().state === "PAUSED") return;
    const active = this.requireClock().activeElapsedAt(uptimeMs);
    this.requireSession().touchBlank(active);
  }

  buildResultDraft(): GameResultDraft {
    if (this.terminated) throw new Error("terminated execution cannot produce a formal result draft");
    return this.requireSession().buildResultDraft();
  }

  async dispose(): Promise<void> {
    this.preparedContext = null;
    this.session = null;
    this.clock = null;
    this.pauseStartedUptimeMs = null;
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
