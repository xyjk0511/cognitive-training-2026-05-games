import { SESSION_DURATION_MS } from "../constants.js";

export type LogicalClockState = "IDLE" | "RUNNING" | "PAUSED" | "DEADLINE_REACHED" | "TERMINATED";

function requireUptime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

/**
 * Pure externally-driven active-time clock. It never reads a system clock and
 * can therefore be advanced instantly by tests or driven by Android uptime.
 */
export class DeterministicActiveClock {
  private stateValue: LogicalClockState = "IDLE";
  private sourceUptimeValue = 0;
  private activeElapsedValue = 0;
  private cutoffUptimeValue: number | null = null;
  private pauseStartedUptimeValue: number | null = null;
  private pauseCountValue = 0;
  private totalPausedUptimeValue = 0;

  get state(): LogicalClockState { return this.stateValue; }
  get sourceUptimeMs(): number { return this.sourceUptimeValue; }
  get activeElapsedMs(): number { return this.activeElapsedValue; }
  get cutoffUptimeMs(): number | null { return this.cutoffUptimeValue; }
  get pauseCount(): number { return this.pauseCountValue; }
  get totalPausedUptimeMs(): number { return this.totalPausedUptimeValue; }

  startAt(effectiveStartUptimeMs: number, cutoffUptimeMs: number): void {
    requireUptime(effectiveStartUptimeMs, "effectiveStartUptimeMs");
    requireUptime(cutoffUptimeMs, "cutoffUptimeMs");
    if (this.stateValue !== "IDLE") throw new Error("clock can only start from IDLE");
    if (cutoffUptimeMs - effectiveStartUptimeMs !== SESSION_DURATION_MS) {
      throw new Error("initial cutoff must be exactly 300000ms after effective start");
    }
    this.sourceUptimeValue = effectiveStartUptimeMs;
    this.cutoffUptimeValue = cutoffUptimeMs;
    this.activeElapsedValue = 0;
    this.stateValue = "RUNNING";
  }

  advanceTo(sourceUptimeMs: number): number {
    requireUptime(sourceUptimeMs, "sourceUptimeMs");
    if (sourceUptimeMs < this.sourceUptimeValue) throw new Error("source uptime cannot move backwards");
    if (this.stateValue === "IDLE") throw new Error("clock has not started");
    if (this.stateValue === "TERMINATED" || this.stateValue === "DEADLINE_REACHED") {
      this.sourceUptimeValue = sourceUptimeMs;
      return this.activeElapsedValue;
    }
    if (this.stateValue === "PAUSED") {
      this.sourceUptimeValue = sourceUptimeMs;
      return this.activeElapsedValue;
    }
    const cutoff = this.cutoffUptimeValue;
    if (cutoff === null) throw new Error("running clock has no cutoff");
    const effectiveSource = Math.min(sourceUptimeMs, cutoff);
    this.activeElapsedValue += effectiveSource - this.sourceUptimeValue;
    this.sourceUptimeValue = sourceUptimeMs;
    if (this.activeElapsedValue >= SESSION_DURATION_MS || sourceUptimeMs >= cutoff) {
      this.activeElapsedValue = SESSION_DURATION_MS;
      this.stateValue = "DEADLINE_REACHED";
    }
    return this.activeElapsedValue;
  }

  pauseAt(effectivePauseUptimeMs: number): void {
    if (this.stateValue !== "RUNNING") throw new Error("pause requires RUNNING clock");
    this.advanceTo(effectivePauseUptimeMs);
    if (this.stateValue !== "RUNNING") throw new Error("pause boundary must precede deadline");
    this.stateValue = "PAUSED";
    this.pauseStartedUptimeValue = effectivePauseUptimeMs;
    this.pauseCountValue += 1;
  }

  resumeAt(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): number {
    requireUptime(resumeInputEnabledUptimeMs, "resumeInputEnabledUptimeMs");
    requireUptime(cutoffUptimeMs, "cutoffUptimeMs");
    if (this.stateValue !== "PAUSED") throw new Error("resume requires PAUSED clock");
    if (resumeInputEnabledUptimeMs < this.sourceUptimeValue) throw new Error("resume uptime cannot move backwards");
    const pauseStarted = this.pauseStartedUptimeValue;
    if (pauseStarted === null) throw new Error("paused clock lacks pause boundary");
    const pausedDuration = resumeInputEnabledUptimeMs - pauseStarted;
    const remainingActive = SESSION_DURATION_MS - this.activeElapsedValue;
    if (cutoffUptimeMs - resumeInputEnabledUptimeMs !== remainingActive) {
      throw new Error("resume cutoff does not preserve remaining active duration");
    }
    this.sourceUptimeValue = resumeInputEnabledUptimeMs;
    this.cutoffUptimeValue = cutoffUptimeMs;
    this.pauseStartedUptimeValue = null;
    this.totalPausedUptimeValue += pausedDuration;
    this.stateValue = "RUNNING";
    return pausedDuration;
  }

  reachDeadlineAt(cutoffUptimeMs: number): void {
    requireUptime(cutoffUptimeMs, "cutoffUptimeMs");
    if (this.stateValue === "PAUSED") throw new Error("active-time deadline cannot be reached while paused");
    if (this.cutoffUptimeValue !== cutoffUptimeMs) throw new Error("deadline does not match the current cutoff");
    this.advanceTo(cutoffUptimeMs);
    if (this.activeElapsedValue !== SESSION_DURATION_MS) throw new Error("deadline did not reach 300000 active ms");
    this.stateValue = "DEADLINE_REACHED";
  }

  canAcceptInputAt(sourceUptimeMs: number): boolean {
    if (this.stateValue !== "RUNNING") return false;
    const cutoff = this.cutoffUptimeValue;
    if (cutoff === null || sourceUptimeMs >= cutoff) {
      this.advanceTo(sourceUptimeMs);
      return false;
    }
    this.advanceTo(sourceUptimeMs);
    return this.stateValue === "RUNNING" && this.activeElapsedValue < SESSION_DURATION_MS;
  }

  terminate(): void {
    if (this.stateValue === "IDLE") throw new Error("cannot terminate an unstarted clock");
    this.stateValue = "TERMINATED";
  }
}
