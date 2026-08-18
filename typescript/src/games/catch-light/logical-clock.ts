import { SESSION_DURATION_MS } from "./types.js";

type ClockState = "IDLE" | "RUNNING" | "PAUSED" | "DEADLINE";

export class ActiveLogicalClock {
  private clockState: ClockState = "IDLE";
  private accumulatedActiveMs = 0;
  private runningSegmentStartUptimeMs: number | null = null;
  private latestObservedUptimeMs: number | null = null;
  private cutoffUptimeMs: number | null = null;

  get state(): ClockState { return this.clockState; }

  start(effectiveStartUptimeMs: number, cutoffUptimeMs: number): void {
    this.assertUptime(effectiveStartUptimeMs, "effectiveStartUptimeMs");
    this.assertUptime(cutoffUptimeMs, "cutoffUptimeMs");
    if (this.clockState !== "IDLE") throw new Error("clock can only start once");
    if (cutoffUptimeMs < effectiveStartUptimeMs) throw new Error("cutoff precedes effective start");
    if (cutoffUptimeMs - effectiveStartUptimeMs !== SESSION_DURATION_MS) {
      throw new Error("initial cutoff must be exactly 300000ms after effective start");
    }
    this.runningSegmentStartUptimeMs = effectiveStartUptimeMs;
    this.latestObservedUptimeMs = effectiveStartUptimeMs;
    this.cutoffUptimeMs = cutoffUptimeMs;
    this.clockState = "RUNNING";
  }

  /**
   * Validates a PAUSE boundary and computes its active time without mutating the
   * clock. The adapter uses this preflight before advancing domain state, so a
   * rejected PAUSE cannot close batches or consume input time as a side effect.
   */
  previewPause(effectivePauseUptimeMs: number): number {
    if (this.clockState !== "RUNNING") throw new Error("pause requires RUNNING clock");
    this.assertUptime(effectivePauseUptimeMs, "effectivePauseUptimeMs");
    this.assertMonotonicCandidate(effectivePauseUptimeMs);
    if (this.cutoffUptimeMs === null) throw new Error("running clock has no cutoff");
    if (effectivePauseUptimeMs >= this.cutoffUptimeMs) {
      throw new Error("pause boundary must be strictly before the authoritative cutoff");
    }
    return this.runningActiveAt(effectivePauseUptimeMs);
  }

  pause(effectivePauseUptimeMs: number): number {
    const active = this.previewPause(effectivePauseUptimeMs);
    this.latestObservedUptimeMs = effectivePauseUptimeMs;
    this.accumulatedActiveMs = active;
    this.runningSegmentStartUptimeMs = null;
    this.clockState = "PAUSED";
    return active;
  }

  /** Performs the complete RESUME validation without changing clock state. */
  validateResume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void {
    if (this.clockState !== "PAUSED") throw new Error("resume requires PAUSED clock");
    this.assertUptime(resumeInputEnabledUptimeMs, "resumeInputEnabledUptimeMs");
    this.assertUptime(cutoffUptimeMs, "cutoffUptimeMs");
    this.assertMonotonicCandidate(resumeInputEnabledUptimeMs);
    if (cutoffUptimeMs < resumeInputEnabledUptimeMs) throw new Error("cutoff precedes resumed input enable");
    const remainingActiveMs = SESSION_DURATION_MS - this.accumulatedActiveMs;
    if (cutoffUptimeMs - resumeInputEnabledUptimeMs !== remainingActiveMs) {
      throw new Error("resumed cutoff does not match the remaining active duration");
    }
  }

  resume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void {
    this.validateResume(resumeInputEnabledUptimeMs, cutoffUptimeMs);
    this.runningSegmentStartUptimeMs = resumeInputEnabledUptimeMs;
    this.latestObservedUptimeMs = resumeInputEnabledUptimeMs;
    this.cutoffUptimeMs = cutoffUptimeMs;
    this.clockState = "RUNNING";
  }

  activeElapsedAt(uptimeMs: number): number {
    if (this.clockState === "IDLE") throw new Error("clock has not started");
    // Once DEADLINE seals active time, the caller's uptime is informational.
    // This permits an authoritative-cutoff snapshot even when a render frame
    // with a later uptime was observed before the DEADLINE callback arrived.
    this.assertUptime(uptimeMs, "uptimeMs");
    if (this.clockState === "DEADLINE") return this.accumulatedActiveMs;
    this.assertMonotonic(uptimeMs);
    if (this.clockState === "PAUSED") return this.accumulatedActiveMs;
    return this.runningActiveAt(uptimeMs);
  }

  deadline(cutoffUptimeMs: number): number {
    if (this.clockState !== "RUNNING") throw new Error("deadline requires RUNNING clock; paused time cannot satisfy the active-duration cutoff");
    this.assertUptime(cutoffUptimeMs, "cutoffUptimeMs");
    if (this.cutoffUptimeMs !== null && cutoffUptimeMs !== this.cutoffUptimeMs) throw new Error("deadline cutoff differs from latest controller cutoff");

    // DEADLINE is authoritative at the controller-owned cutoff. A render/input frame may
    // have observed an uptime later than that cutoff before the DEADLINE callback arrives;
    // recomputing directly avoids treating that legitimate callback as a clock rollback.
    const active = this.runningActiveAt(cutoffUptimeMs);
    this.latestObservedUptimeMs = Math.max(this.latestObservedUptimeMs ?? cutoffUptimeMs, cutoffUptimeMs);
    this.accumulatedActiveMs = active;
    this.runningSegmentStartUptimeMs = null;
    this.clockState = "DEADLINE";
    return active;
  }

  private runningActiveAt(uptimeMs: number): number {
    if (this.runningSegmentStartUptimeMs === null) throw new Error("running clock has no segment start");
    const boundedUptime = this.cutoffUptimeMs === null ? uptimeMs : Math.min(uptimeMs, this.cutoffUptimeMs);
    const remainingActiveMs = SESSION_DURATION_MS - this.accumulatedActiveMs;
    const segmentActiveMs = Math.min(remainingActiveMs, Math.max(0, boundedUptime - this.runningSegmentStartUptimeMs));
    return this.accumulatedActiveMs + segmentActiveMs;
  }

  private assertUptime(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  }

  private assertMonotonicCandidate(value: number): void {
    if (this.latestObservedUptimeMs !== null && value < this.latestObservedUptimeMs) throw new Error("uptime moved backwards");
  }

  private assertMonotonic(value: number): void {
    this.assertUptime(value, "uptimeMs");
    this.assertMonotonicCandidate(value);
    this.latestObservedUptimeMs = value;
  }
}
