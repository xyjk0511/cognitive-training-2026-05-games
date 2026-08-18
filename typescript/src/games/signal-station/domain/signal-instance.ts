import type {
  GeneratedSignalInstance, ObjectState, ReactionSummary, TouchDisposition, TouchResult,
} from "../types.js";

export type InstanceOutcome = "PENDING" | "HIT" | "FALSE_TOUCH" | "MISS";

export interface InstanceAudit {
  readonly instanceId: string;
  readonly role: "TARGET" | "DISTRACTOR";
  readonly requiresDouble: boolean;
  readonly outcome: InstanceOutcome;
  readonly firstTouchActiveMs: number | null;
  readonly completionTouchActiveMs: number | null;
  readonly firstReactionMs: number | null;
  readonly doubleIntervalMs: number | null;
  readonly secondDeadlineActiveMs: number | null;
}

function ignored(disposition: TouchDisposition, instanceId: string, stateAfter: ObjectState): TouchResult {
  return Object.freeze({disposition, instanceId, stateAfter, hitDelta: 0, falseTouchDelta: 0});
}

function requireSafeInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`);
}

function checkedAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} exceeded the safe-integer range`);
  return result;
}

export class SignalInstanceRuntime {
  readonly definition: GeneratedSignalInstance;
  readonly enterStartActiveMs: number;
  readonly naturalExitEndActiveMs: number;
  private readonly enteringEndActiveMs: number;
  private readonly activeEndActiveMs: number;
  private readonly doubleWindowMs: number;
  private outcomeValue: InstanceOutcome = "PENDING";
  private waitingSecond = false;
  private firstTouchValue: number | null = null;
  private completionTouchValue: number | null = null;
  private secondDeadlineValue: number | null = null;
  private latestActiveMs: number;
  private readonly processedEventIds = new Set<string>();

  constructor(
    definition: GeneratedSignalInstance,
    batchStartActiveMs: number,
    enteringMs: number,
    activeMs: number,
    doubleWindowMs: number,
  ) {
    if (!Number.isSafeInteger(batchStartActiveMs)) throw new Error("batchStartActiveMs must be a safe integer");
    requireSafeInteger(definition.enterStartInBatchMs, "enterStartInBatchMs");
    requireSafeInteger(definition.naturalExitEndInBatchMs, "naturalExitEndInBatchMs");
    requireSafeInteger(enteringMs, "enteringMs");
    requireSafeInteger(activeMs, "activeMs", 1);
    requireSafeInteger(doubleWindowMs, "doubleWindowMs", 1);
    if (definition.naturalExitEndInBatchMs <= definition.enterStartInBatchMs) throw new Error("instance lifecycle must be positive");
    this.definition = definition;
    this.enterStartActiveMs = checkedAdd(batchStartActiveMs, definition.enterStartInBatchMs, "enterStartActiveMs");
    this.naturalExitEndActiveMs = checkedAdd(batchStartActiveMs, definition.naturalExitEndInBatchMs, "naturalExitEndActiveMs");
    this.enteringEndActiveMs = checkedAdd(this.enterStartActiveMs, enteringMs, "enteringEndActiveMs");
    this.activeEndActiveMs = checkedAdd(this.enteringEndActiveMs, activeMs, "activeEndActiveMs");
    if (this.activeEndActiveMs > this.naturalExitEndActiveMs) throw new Error("entering+active exceeds the natural lifecycle");
    this.doubleWindowMs = doubleWindowMs;
    this.latestActiveMs = batchStartActiveMs;
  }

  get outcome(): InstanceOutcome { return this.outcomeValue; }
  get firstTouchActiveMs(): number | null { return this.firstTouchValue; }
  get completionTouchActiveMs(): number | null { return this.completionTouchValue; }
  get secondDeadlineActiveMs(): number | null { return this.secondDeadlineValue; }

  advanceTo(activeMs: number): void {
    if (!Number.isSafeInteger(activeMs) || activeMs < this.latestActiveMs) throw new Error("instance active time cannot move backwards");
    this.latestActiveMs = activeMs;
    if (this.outcomeValue !== "PENDING") return;
    if (this.waitingSecond && this.secondDeadlineValue !== null && activeMs >= this.secondDeadlineValue) {
      this.waitingSecond = false;
      this.outcomeValue = "MISS";
      return;
    }
    if (this.definition.role === "TARGET" && activeMs >= this.naturalExitEndActiveMs) {
      this.waitingSecond = false;
      this.outcomeValue = "MISS";
    }
  }

  stateAt(activeMs: number): ObjectState {
    this.advanceTo(activeMs);
    if (activeMs >= this.naturalExitEndActiveMs) return "GONE";
    if (this.outcomeValue === "HIT") return "HIT";
    if (this.outcomeValue === "FALSE_TOUCH") return "FALSE_TOUCH";
    if (this.outcomeValue === "MISS") return "TIMEOUT";
    if (this.waitingSecond) return "WAIT_SECOND";
    if (activeMs < this.enterStartActiveMs) return "SCHEDULED";
    if (activeMs < this.enteringEndActiveMs) return "ENTERING";
    if (activeMs < this.activeEndActiveMs) return "ACTIVE";
    return "EXITING";
  }

  touch(activeMs: number, eventId: string): TouchResult {
    if (typeof eventId !== "string" || eventId.length === 0) throw new Error("eventId must not be empty");
    if (this.processedEventIds.has(eventId)) {
      return ignored("IGNORED_DUPLICATE_EVENT", this.definition.instanceId, this.stateAt(Math.max(activeMs, this.latestActiveMs)));
    }
    this.processedEventIds.add(eventId);
    const stateBefore = this.stateAt(activeMs);
    if (activeMs < this.enterStartActiveMs || activeMs >= this.naturalExitEndActiveMs) {
      return ignored("IGNORED_OUTSIDE_WINDOW", this.definition.instanceId, stateBefore);
    }
    if (
      this.definition.requiresDouble
      && this.firstTouchValue !== null
      && this.secondDeadlineValue !== null
      && activeMs >= this.secondDeadlineValue
    ) {
      return ignored("IGNORED_OUTSIDE_WINDOW", this.definition.instanceId, stateBefore);
    }
    if (this.outcomeValue !== "PENDING") return ignored("IGNORED_LOCKED", this.definition.instanceId, stateBefore);

    if (this.definition.role === "DISTRACTOR") {
      this.firstTouchValue = activeMs;
      this.completionTouchValue = activeMs;
      this.outcomeValue = "FALSE_TOUCH";
      return Object.freeze({
        disposition: "DISTRACTOR_FALSE_TOUCH",
        instanceId: this.definition.instanceId,
        stateAfter: "FALSE_TOUCH",
        hitDelta: 0,
        falseTouchDelta: 1,
      });
    }

    if (!this.definition.requiresDouble) {
      this.firstTouchValue = activeMs;
      this.completionTouchValue = activeMs;
      this.outcomeValue = "HIT";
      return Object.freeze({
        disposition: "TARGET_HIT",
        instanceId: this.definition.instanceId,
        stateAfter: "HIT",
        hitDelta: 1,
        falseTouchDelta: 0,
      });
    }

    if (!this.waitingSecond) {
      this.waitingSecond = true;
      this.firstTouchValue = activeMs;
      this.secondDeadlineValue = Math.min(activeMs + this.doubleWindowMs, this.naturalExitEndActiveMs);
      return Object.freeze({
        disposition: "DOUBLE_FIRST",
        instanceId: this.definition.instanceId,
        stateAfter: "WAIT_SECOND",
        hitDelta: 0,
        falseTouchDelta: 0,
      });
    }

    const deadline = this.secondDeadlineValue;
    if (deadline === null || activeMs >= deadline) {
      this.advanceTo(activeMs);
      return ignored("IGNORED_OUTSIDE_WINDOW", this.definition.instanceId, this.stateAt(activeMs));
    }
    this.waitingSecond = false;
    this.completionTouchValue = activeMs;
    this.outcomeValue = "HIT";
    return Object.freeze({
      disposition: "DOUBLE_COMPLETED",
      instanceId: this.definition.instanceId,
      stateAfter: "HIT",
      hitDelta: 1,
      falseTouchDelta: 0,
    });
  }

  isPresentedBefore(activeMsExclusive: number): boolean {
    return this.enterStartActiveMs < activeMsExclusive;
  }

  firstReactionMs(): number | null {
    return this.firstTouchValue === null ? null : this.firstTouchValue - this.enterStartActiveMs;
  }

  doubleIntervalMs(): number | null {
    if (!this.definition.requiresDouble || this.firstTouchValue === null || this.completionTouchValue === null) return null;
    return this.completionTouchValue - this.firstTouchValue;
  }

  audit(): InstanceAudit {
    return Object.freeze({
      instanceId: this.definition.instanceId,
      role: this.definition.role,
      requiresDouble: this.definition.requiresDouble,
      outcome: this.outcomeValue,
      firstTouchActiveMs: this.firstTouchValue,
      completionTouchActiveMs: this.completionTouchValue,
      firstReactionMs: this.firstReactionMs(),
      doubleIntervalMs: this.doubleIntervalMs(),
      secondDeadlineActiveMs: this.secondDeadlineValue,
    });
  }
}

export function summarizeIntegerDurations(values: readonly number[]): ReactionSummary {
  if (values.length === 0) return Object.freeze({count: 0, totalMs: 0, minMs: null, maxMs: null});
  for (const value of values) if (!Number.isSafeInteger(value) || value < 0) throw new Error("duration summary contains an invalid value");
  const totalMs = values.reduce((sum, value) => checkedAdd(sum, value, "duration total"), 0);
  return Object.freeze({
    count: values.length,
    totalMs,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  });
}
