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
    this.definition = definition;
    this.enterStartActiveMs = batchStartActiveMs + definition.enterStartInBatchMs;
    this.naturalExitEndActiveMs = batchStartActiveMs + definition.naturalExitEndInBatchMs;
    this.enteringEndActiveMs = this.enterStartActiveMs + enteringMs;
    this.activeEndActiveMs = this.enteringEndActiveMs + activeMs;
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
    if (eventId.length === 0) throw new Error("eventId must not be empty");
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
  return Object.freeze({
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  });
}
