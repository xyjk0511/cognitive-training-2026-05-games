import {
  HIT_FEEDBACK_MS,
  type FruitInteractionState,
  type FruitVisualPhase,
  type GeneratedInstance,
  type InstanceAudit,
  type TouchResult,
} from "./types.js";

const NO_CHANGE: Omit<TouchResult, "disposition"> = Object.freeze({changedStatistics:false, hitDelta:0, falseTouchDelta:0});

export class FruitObjectRuntime {
  readonly instance: GeneratedInstance;
  private interactionState: FruitInteractionState = "SCHEDULED";
  private firstTouchActiveMs: number | null = null;
  private secondTouchActiveMs: number | null = null;
  private lastTouchActiveMs: number | null = null;
  private secondDeadlineActiveMs: number | null = null;
  private settledAtActiveMs: number | null = null;

  constructor(instance: GeneratedInstance) {
    this.instance = instance;
  }

  get state(): FruitInteractionState { return this.interactionState; }
  get firstTouchMs(): number | null { return this.firstTouchActiveMs; }
  get secondTouchMs(): number | null { return this.secondTouchActiveMs; }
  get secondDeadlineMs(): number | null { return this.secondDeadlineActiveMs; }

  private isSettled(): boolean {
    return this.interactionState === "HIT"
      || this.interactionState === "COMPLETED"
      || this.interactionState === "FALSE_TOUCH"
      || this.interactionState === "TIMEOUT"
      || this.interactionState === "GONE";
  }

  advanceTo(activeMs: number): void {
    if (!Number.isSafeInteger(activeMs) || activeMs < 0) throw new Error("activeMs must be a non-negative safe integer");
    if (this.isSettled()) {
      if (this.interactionState === "TIMEOUT") {
        if (activeMs >= this.instance.activeDeadlineMs) this.interactionState = "GONE";
        return;
      }
      if (this.settledAtActiveMs !== null && activeMs >= this.settledAtActiveMs + HIT_FEEDBACK_MS) {
        this.interactionState = "GONE";
      }
      return;
    }
    if (activeMs < this.instance.activeStartMs) {
      this.interactionState = "SCHEDULED";
      return;
    }
    if (this.interactionState === "WAIT_SECOND" && this.secondDeadlineActiveMs !== null && activeMs >= this.secondDeadlineActiveMs) {
      this.interactionState = "TIMEOUT";
      this.settledAtActiveMs = this.secondDeadlineActiveMs;
      return;
    }
    if (activeMs >= this.instance.activeDeadlineMs) {
      this.interactionState = "TIMEOUT";
      this.settledAtActiveMs = this.instance.activeDeadlineMs;
      return;
    }
    if (this.interactionState === "WAIT_SECOND") return;
    if (this.instance.isDouble) {
      this.interactionState = "ACTIVE_FIRST";
    } else if (activeMs < this.instance.enterEndMs) {
      this.interactionState = "ENTERING";
    } else if (activeMs < this.instance.exitStartMs) {
      this.interactionState = "ACTIVE";
    } else {
      this.interactionState = "EXITING";
    }
  }

  touch(activeMs: number): TouchResult {
    if (!Number.isSafeInteger(activeMs) || activeMs < 0) throw new Error("activeMs must be a non-negative safe integer");
    if (activeMs < this.instance.activeStartMs) {
      return {disposition:"IGNORED_BEFORE_WINDOW", ...NO_CHANGE};
    }
    if (this.lastTouchActiveMs === activeMs) {
      return {disposition:"IGNORED_SAME_TIMESTAMP", ...NO_CHANGE};
    }
    this.advanceTo(activeMs);
    this.lastTouchActiveMs = activeMs;
    if (activeMs >= this.instance.activeDeadlineMs || this.interactionState === "TIMEOUT") {
      return {disposition:"IGNORED_AT_OR_AFTER_DEADLINE", ...NO_CHANGE};
    }
    if (this.interactionState === "HIT" || this.interactionState === "COMPLETED" || this.interactionState === "FALSE_TOUCH" || this.interactionState === "GONE") {
      return {disposition:"IGNORED_ALREADY_SETTLED", ...NO_CHANGE};
    }

    if (this.interactionState === "WAIT_SECOND") {
      if (this.secondDeadlineActiveMs === null || activeMs >= this.secondDeadlineActiveMs) {
        this.advanceTo(activeMs);
        return {disposition:"IGNORED_AT_OR_AFTER_DEADLINE", ...NO_CHANGE};
      }
      this.secondTouchActiveMs = activeMs;
      this.interactionState = "COMPLETED";
      this.settledAtActiveMs = activeMs;
      return {disposition:"DOUBLE_COMPLETED", changedStatistics:true, hitDelta:1, falseTouchDelta:0};
    }

    if (this.instance.role === "DISTRACTOR") {
      this.firstTouchActiveMs = activeMs;
      this.interactionState = "FALSE_TOUCH";
      this.settledAtActiveMs = activeMs;
      return {disposition:"DISTRACTOR_FALSE_TOUCH", changedStatistics:true, hitDelta:0, falseTouchDelta:1};
    }

    if (this.instance.isDouble) {
      this.firstTouchActiveMs = activeMs;
      this.secondDeadlineActiveMs = Math.min(activeMs + this.instance.doubleWindowMs, this.instance.activeDeadlineMs);
      this.interactionState = "WAIT_SECOND";
      return {disposition:"DOUBLE_FIRST", changedStatistics:false, hitDelta:0, falseTouchDelta:0};
    }

    this.firstTouchActiveMs = activeMs;
    this.interactionState = "HIT";
    this.settledAtActiveMs = activeMs;
    return {disposition:"TARGET_HIT", changedStatistics:true, hitDelta:1, falseTouchDelta:0};
  }

  visualPhaseAt(activeMs: number): FruitVisualPhase {
    this.advanceTo(activeMs);
    if (activeMs < this.instance.activeStartMs) return "HIDDEN";
    if (this.interactionState === "TIMEOUT") {
      if (activeMs >= this.instance.activeDeadlineMs) return "GONE";
      return activeMs < this.instance.exitStartMs ? "ACTIVE" : "EXITING";
    }
    if (this.settledAtActiveMs !== null) {
      return activeMs < this.settledAtActiveMs + HIT_FEEDBACK_MS ? "FEEDBACK" : "GONE";
    }
    if (activeMs >= this.instance.activeDeadlineMs) return "GONE";
    if (activeMs < this.instance.enterEndMs) return "ENTERING";
    if (activeMs < this.instance.exitStartMs) return "ACTIVE";
    return "EXITING";
  }

  auditAt(activeMs: number): InstanceAudit {
    this.advanceTo(activeMs);
    let outcome: InstanceAudit["outcome"];
    if (this.instance.role === "DISTRACTOR") {
      if (this.firstTouchActiveMs !== null) outcome = "FALSE_TOUCH";
      else if (activeMs >= this.instance.activeDeadlineMs || this.interactionState === "TIMEOUT" || this.interactionState === "GONE") outcome = "AVOIDED";
      else outcome = "UNRESOLVED";
    } else if (this.interactionState === "HIT" || this.interactionState === "COMPLETED" || (this.interactionState === "GONE" && this.firstTouchActiveMs !== null && (!this.instance.isDouble || this.secondTouchActiveMs !== null))) {
      outcome = "HIT";
    } else if (activeMs >= this.instance.activeDeadlineMs || this.interactionState === "TIMEOUT" || this.interactionState === "GONE") {
      outcome = "TIMEOUT";
    } else {
      outcome = "UNRESOLVED";
    }
    return {
      instanceId: this.instance.instanceId,
      fruitId: this.instance.fruitId,
      role: this.instance.role,
      slotId: this.instance.slotId,
      isDouble: this.instance.isDouble,
      firstTouchActiveMs: this.firstTouchActiveMs,
      secondTouchActiveMs: this.secondTouchActiveMs,
      outcome,
    };
  }
}
