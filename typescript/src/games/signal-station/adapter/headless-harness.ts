import { canonicalSha256 } from "../../../canonical.js";
import type { GameResultDraft } from "../../../contracts.js";
import { BATCH_DURATION_MS, SESSION_DURATION_MS, TIMING_PROFILES } from "../constants.js";
import {
  getVerticalSliceLevelConfig, isVerticalSliceLevelImplemented, VERTICAL_SLICE_RUNTIME_CONFIG,
} from "../config/vertical-slices.js";
import type { GeneratedBatchPlan, TouchDisposition, TouchResult } from "../types.js";
import { SignalStationSession } from "../domain/session.js";

export interface HeadlessHarnessOptions {
  readonly sessionSeed: number;
  readonly sessionStartLevel: number;
  readonly runtimeConfigHash?: string;
}

export interface AutomatedBatchResponse {
  readonly targetHits: number;
  readonly falseTouches: number;
  readonly reactionOffsetMs: number;
  readonly doubleSecondGapMs?: number;
}

interface ScheduledTouch {
  readonly activeMs: number;
  readonly instanceId: string;
  readonly eventId: string;
  readonly expectedDisposition: TouchDisposition;
}

function compareText(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function requireCount(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a safe integer in [0,${maximum}]`);
  }
}

function requireDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

export class SignalStationHeadlessHarness {
  readonly session: SignalStationSession;
  private eventSequence = 0;

  constructor(options: HeadlessHarnessOptions) {
    this.session = new SignalStationSession({
      sessionSeed: options.sessionSeed,
      sessionStartLevel: options.sessionStartLevel,
      runtimeConfigHash: options.runtimeConfigHash ?? canonicalSha256(VERTICAL_SLICE_RUNTIME_CONFIG),
    });
  }

  beginBatchAt(activeMs: number): GeneratedBatchPlan {
    return this.session.startBatch(activeMs);
  }

  advanceToActiveMs(activeMs: number): void {
    this.session.advanceTo(activeMs);
  }

  tap(instanceId: string | null, activeMs: number, eventId?: string): TouchResult {
    const resolvedEventId = eventId ?? `headless-touch-${++this.eventSequence}`;
    return this.session.touch(instanceId, activeMs, resolvedEventId);
  }

  respondToCurrentBatch(response: AutomatedBatchResponse): void {
    const batch = this.session.currentBatch;
    if (batch === null) throw new Error("no active batch to respond to");
    const targets = batch.plan.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "TARGET");
    const distractors = batch.plan.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "DISTRACTOR");
    requireCount(response.targetHits, "targetHits", targets.length);
    requireCount(response.falseTouches, "falseTouches", distractors.length);
    requireDuration(response.reactionOffsetMs, "reactionOffsetMs");
    const secondGap = response.doubleSecondGapMs ?? 1;
    requireDuration(secondGap, "doubleSecondGapMs");

    const profile = TIMING_PROFILES[batch.config.timingProfile];
    if (response.reactionOffsetMs >= profile.lifecycleMs) {
      throw new Error("reactionOffsetMs must remain inside the signal half-open lifecycle");
    }
    const scheduled: ScheduledTouch[] = [];
    let sequence = 0;
    for (const instance of targets.slice(0, response.targetHits)) {
      const first = batch.batchStartActiveMs + instance.enterStartInBatchMs + response.reactionOffsetMs;
      scheduled.push({
        activeMs: first,
        instanceId: instance.instanceId,
        eventId: `auto-${batch.batchOrdinal}-${sequence++}-first`,
        expectedDisposition: instance.requiresDouble ? "DOUBLE_FIRST" : "TARGET_HIT",
      });
      if (instance.requiresDouble) {
        if (secondGap >= profile.doubleWindowMs || response.reactionOffsetMs + secondGap >= profile.lifecycleMs) {
          throw new Error("doubleSecondGapMs must stay inside both the double window and signal lifecycle");
        }
        scheduled.push({
          activeMs: first + secondGap,
          instanceId: instance.instanceId,
          eventId: `auto-${batch.batchOrdinal}-${sequence++}-second`,
          expectedDisposition: "DOUBLE_COMPLETED",
        });
      }
    }
    for (const instance of distractors.slice(0, response.falseTouches)) {
      const first = batch.batchStartActiveMs + instance.enterStartInBatchMs + response.reactionOffsetMs;
      scheduled.push({
        activeMs: first,
        instanceId: instance.instanceId,
        eventId: `auto-${batch.batchOrdinal}-${sequence++}-false`,
        expectedDisposition: "DISTRACTOR_FALSE_TOUCH",
      });
    }
    scheduled.sort((left, right) => left.activeMs - right.activeMs
      || compareText(left.instanceId, right.instanceId)
      || compareText(left.eventId, right.eventId));
    for (const touch of scheduled) {
      const result = this.tap(touch.instanceId, touch.activeMs, touch.eventId);
      if (result.disposition !== touch.expectedDisposition) {
        throw new Error(`automated touch ${touch.eventId} expected ${touch.expectedDisposition}, got ${result.disposition}`);
      }
    }
  }

  runClosedBatches(count: number, response: AutomatedBatchResponse): void {
    if (this.session.currentBatch !== null) throw new Error("runClosedBatches requires no active batch");
    requireCount(count, "count", 8 - this.session.eligibleBatchCount);
    for (let index = 0; index < count; index += 1) {
      if (!isVerticalSliceLevelImplemented(this.session.currentLevel)) {
        throw new Error(`headless run cannot continue at unimplemented level ${this.session.currentLevel}`);
      }
      const start = this.session.eligibleBatchCount * BATCH_DURATION_MS;
      this.beginBatchAt(start);
      this.respondToCurrentBatch(response);
      this.advanceToActiveMs(start + BATCH_DURATION_MS);
    }
  }

  beginPartialBatchAt(activeMs: number): GeneratedBatchPlan {
    return this.beginBatchAt(activeMs);
  }

  finalizeAtDeadline(): GameResultDraft {
    this.session.deadline();
    return this.session.buildResultDraft();
  }

  static holdResponseForLevel(level: number, reactionOffsetMs = 1): AutomatedBatchResponse {
    const config = getVerticalSliceLevelConfig(level);
    requireDuration(reactionOffsetMs, "reactionOffsetMs");
    switch (config.waveTemplate) {
      case "P10_D0":
        return Object.freeze({targetHits: 7, falseTouches: 0, reactionOffsetMs});
      case "P15_D5":
        return Object.freeze({targetHits: 11, falseTouches: 1, reactionOffsetMs});
      case "P20_D5":
        return Object.freeze({targetHits: 14, falseTouches: 1, reactionOffsetMs});
      case "P20_D10":
        return Object.freeze({targetHits: 14, falseTouches: 3, reactionOffsetMs});
    }
  }

  static completeSessionWithEligibleCount(options: HeadlessHarnessOptions, eligibleCount: number): GameResultDraft {
    const harness = new SignalStationHeadlessHarness(options);
    harness.runClosedBatches(eligibleCount, SignalStationHeadlessHarness.holdResponseForLevel(options.sessionStartLevel));
    return harness.finalizeAtDeadline();
  }
}

export function assertDeadlineConstant(value: number): asserts value is 300000 {
  if (value !== SESSION_DURATION_MS) throw new Error("deadline active time must be 300000ms");
}
