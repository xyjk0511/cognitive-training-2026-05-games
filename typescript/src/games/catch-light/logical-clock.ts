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
    this.runningSegmentStartUptimeMs = effectiveStartUptimeMs;
    this.latestObservedUptimeMs = effectiveStartUptimeMs;
    this.cutoffUptimeMs = cutoffUptimeMs;
    this.clockState = "RUNNING";
  }

  pause(effectivePauseUptimeMs: number): number {
    if (this.clockState !== "RUNNING") throw new Error("pause requires RUNNING clock");
    const active = this.activeElapsedAt(effectivePauseUptimeMs);
    this.accumulatedActiveMs = active;
    this.runningSegmentStartUptimeMs = null;
    this.clockState = "PAUSED";
    return active;
  }

  resume(resumeInputEnabledUptimeMs: number, cutoffUptimeMs: number): void {
    if (this.clockState !== "PAUSED") throw new Error("resume requires PAUSED clock");
    this.assertMonotonic(resumeInputEnabledUptimeMs);
    this.assertUptime(cutoffUptimeMs, "cutoffUptimeMs");
    if (cutoffUptimeMs < resumeInputEnabledUptimeMs) throw new Error("cutoff precedes resumed input enable");
    this.runningSegmentStartUptimeMs = resumeInputEnabledUptimeMs;
    this.latestObservedUptimeMs = resumeInputEnabledUptimeMs;
    this.cutoffUptimeMs = cutoffUptimeMs;
    this.clockState = "RUNNING";
  }

  activeElapsedAt(uptimeMs: number): number {
    if (this.clockState === "IDLE") throw new Error("clock has not started");
    this.assertMonotonic(uptimeMs);
    if (this.clockState === "PAUSED" || this.clockState === "DEADLINE") return this.accumulatedActiveMs;
    if (this.runningSegmentStartUptimeMs === null) throw new Error("running clock has no segment start");
    const boundedUptime = this.cutoffUptimeMs === null ? uptimeMs : Math.min(uptimeMs, this.cutoffUptimeMs);
    const remainingActiveMs = SESSION_DURATION_MS - this.accumulatedActiveMs;
    const segmentActiveMs = Math.min(remainingActiveMs, Math.max(0, boundedUptime - this.runningSegmentStartUptimeMs));
    return this.accumulatedActiveMs + segmentActiveMs;
  }

  deadline(cutoffUptimeMs: number): number {
    if (this.clockState !== "RUNNING" && this.clockState !== "PAUSED") throw new Error("deadline requires active clock");
    this.assertUptime(cutoffUptimeMs, "cutoffUptimeMs");
    if (this.cutoffUptimeMs !== null && cutoffUptimeMs !== this.cutoffUptimeMs) throw new Error("deadline cutoff differs from latest controller cutoff");

    // DEADLINE is authoritative at the controller-owned cutoff. A render/input frame may
    // have observed an uptime later than that cutoff before the DEADLINE callback arrives;
    // recomputing directly avoids treating that legitimate callback as a clock rollback.
    let active: number;
    if (this.clockState === "PAUSED") {
      active = this.accumulatedActiveMs;
    } else {
      if (this.runningSegmentStartUptimeMs === null) throw new Error("running clock has no segment start");
      const remainingActiveMs = SESSION_DURATION_MS - this.accumulatedActiveMs;
      const segmentActiveMs = Math.min(remainingActiveMs, Math.max(0, cutoffUptimeMs - this.runningSegmentStartUptimeMs));
      active = this.accumulatedActiveMs + segmentActiveMs;
      this.latestObservedUptimeMs = Math.max(this.latestObservedUptimeMs ?? cutoffUptimeMs, cutoffUptimeMs);
    }
    this.accumulatedActiveMs = active;
    this.runningSegmentStartUptimeMs = null;
    this.clockState = "DEADLINE";
    return active;
  }

  private assertUptime(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  }

  private assertMonotonic(value: number): void {
    this.assertUptime(value, "uptimeMs");
    if (this.latestObservedUptimeMs !== null && value < this.latestObservedUptimeMs) throw new Error("uptime moved backwards");
    this.latestObservedUptimeMs = value;
  }
}
