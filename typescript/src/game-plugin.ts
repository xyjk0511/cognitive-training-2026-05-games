import type { EligibleBatch, GameResultDraft } from "./contracts.js";

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

export type TrainingPointerPhase = "DOWN" | "MOVE" | "UP" | "CANCEL";
export type InputStreamCancellationReason = "PAUSE" | "DEADLINE" | "TERMINATE";

export interface TrainingPointerEvent {
  readonly pointerEventId: string;
  readonly pointerId: string;
  readonly phase: TrainingPointerPhase;
  readonly sourceUptimeMs: number;
  readonly xPx: number;
  readonly yPx: number;
  readonly hitToken: string | null;
}

export type BatchEvidenceSink = (batch: Readonly<EligibleBatch>) => void;

/** Host-only companion SPI. It does not add or change any A620-TRC-1.1 wire field. */
export interface A620InteractiveTrainingGameModule extends A620TrainingGameModule {
  advanceToUptime(sourceUptimeMs: number): number;
  onPointerEvent(event: Readonly<TrainingPointerEvent>): void;
  onInputStreamsCancelled(reason: InputStreamCancellationReason): void;
  setEvidenceSink(sink: BatchEvidenceSink): void;
  retryPendingBatchEvidence(): void;
}

export class TrainingPointerEventGate {
  private readonly processedEventIds = new Set<string>();
  private readonly activePointerIds = new Set<string>();

  accept(event: Readonly<TrainingPointerEvent>): "DOWN" | "IGNORE" {
    if (typeof event.pointerEventId !== "string" || event.pointerEventId.length === 0) {
      throw new Error("pointerEventId must not be empty");
    }
    if (typeof event.pointerId !== "string" || event.pointerId.length === 0) {
      throw new Error("pointerId must not be empty");
    }
    if (!Number.isSafeInteger(event.sourceUptimeMs) || event.sourceUptimeMs < 0) {
      throw new Error("sourceUptimeMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(event.xPx) || !Number.isSafeInteger(event.yPx)) {
      throw new Error("pointer coordinates must be safe integers");
    }
    if (event.hitToken !== null && (typeof event.hitToken !== "string" || event.hitToken.length === 0)) {
      throw new Error("hitToken must be null or a non-empty string");
    }
    if (event.phase !== "DOWN" && event.phase !== "MOVE" && event.phase !== "UP" && event.phase !== "CANCEL") {
      throw new Error(`unsupported pointer phase ${String(event.phase)}`);
    }
    if (this.processedEventIds.has(event.pointerEventId)) return "IGNORE";
    this.processedEventIds.add(event.pointerEventId);

    if (event.phase === "DOWN") {
      if (this.activePointerIds.has(event.pointerId)) return "IGNORE";
      this.activePointerIds.add(event.pointerId);
      return "DOWN";
    }
    if (event.phase === "UP" || event.phase === "CANCEL") this.activePointerIds.delete(event.pointerId);
    return "IGNORE";
  }

  cancelAll(reason: InputStreamCancellationReason): void {
    if (reason !== "PAUSE" && reason !== "DEADLINE" && reason !== "TERMINATE") {
      throw new Error(`unsupported input cancellation reason ${String(reason)}`);
    }
    this.activePointerIds.clear();
  }

  rollbackDown(event: Readonly<TrainingPointerEvent>): void {
    this.processedEventIds.delete(event.pointerEventId);
    this.activePointerIds.delete(event.pointerId);
  }

  reset(): void {
    this.processedEventIds.clear();
    this.activePointerIds.clear();
  }
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
