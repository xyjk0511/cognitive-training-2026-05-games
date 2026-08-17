import type { GameResultDraft } from "./contracts.js";

export interface PrepareContext {
  gameCode: string;
  sessionSeed: number;
  sessionStartLevel: number;
  durationMs: 300000;
  runtimeConfigHash: string;
  gameConfig: Readonly<Record<string, unknown>>;
}

export interface A620TrainingGameModule {
  readonly gameCode: string;
  prepare(context: PrepareContext): Promise<void>;
  onStart(effectiveStartUptimeMs: number, cutoffUptimeMs: number): void;
  onPause(effectivePauseUptimeMs: number): void;
  onResume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void;
  onDeadline(cutoffUptimeMs: number): void;
  onTerminate(reasonCode: string): void;
  buildResultDraft(): GameResultDraft;
  dispose(): Promise<void>;
}

export class CatchLightEmptyPlugin implements A620TrainingGameModule {
  readonly gameCode: string = "CATCH_LIGHT";
  async prepare(_: PrepareContext): Promise<void> {}
  onStart(_: number, __: number): void {}
  onPause(_: number): void {}
  onResume(_: number, __: number): void {}
  onDeadline(_: number): void {}
  onTerminate(_: string): void {}
  buildResultDraft(): GameResultDraft { throw new Error("Catch Light vertical slice not implemented in Gate 0"); }
  async dispose(): Promise<void> {}
}

export class SignalStationEmptyPlugin extends CatchLightEmptyPlugin {
  override readonly gameCode: string = "SIGNAL_STATION";
  override buildResultDraft(): GameResultDraft { throw new Error("Signal Station vertical slice not implemented in Gate 0"); }
}
