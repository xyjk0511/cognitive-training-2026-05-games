import { canonicalSha256 } from "../../../canonical.js";
import type { GameResultDraft } from "../../../contracts.js";
import { BATCH_DURATION_MS, SESSION_DURATION_MS } from "../constants.js";
import { VERTICAL_SLICE_RUNTIME_CONFIG } from "../config/vertical-slices.js";
import type { GeneratedBatchPlan, TouchResult } from "../types.js";
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
}

function compareText(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
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
    if (response.targetHits < 0 || response.targetHits > targets.length) throw new Error("targetHits outside generated target count");
    if (response.falseTouches < 0 || response.falseTouches > distractors.length) throw new Error("falseTouches outside generated distractor count");
    const secondGap = response.doubleSecondGapMs ?? 1;
    const scheduled: ScheduledTouch[] = [];
    let sequence = 0;
    for (const instance of targets.slice(0, response.targetHits)) {
      const first = batch.batchStartActiveMs + instance.enterStartInBatchMs + response.reactionOffsetMs;
      scheduled.push({activeMs: first, instanceId: instance.instanceId, eventId: `auto-${batch.batchOrdinal}-${sequence++}-first`});
      if (instance.requiresDouble) {
        scheduled.push({activeMs: first + secondGap, instanceId: instance.instanceId, eventId: `auto-${batch.batchOrdinal}-${sequence++}-second`});
      }
    }
    for (const instance of distractors.slice(0, response.falseTouches)) {
      const first = batch.batchStartActiveMs + instance.enterStartInBatchMs + response.reactionOffsetMs;
      scheduled.push({activeMs: first, instanceId: instance.instanceId, eventId: `auto-${batch.batchOrdinal}-${sequence++}-false`});
    }
    scheduled.sort((left, right) => left.activeMs - right.activeMs || compareText(left.instanceId, right.instanceId) || compareText(left.eventId, right.eventId));
    for (const touch of scheduled) this.tap(touch.instanceId, touch.activeMs, touch.eventId);
  }

  runClosedBatches(count: number, response: AutomatedBatchResponse): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > 8) throw new Error("count must be in [0,8]");
    for (let index = 0; index < count; index += 1) {
      const start = index * BATCH_DURATION_MS;
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
    if (level === 1) return Object.freeze({targetHits: 7, falseTouches: 0, reactionOffsetMs});
    if (level === 7) return Object.freeze({targetHits: 11, falseTouches: 1, reactionOffsetMs});
    return Object.freeze({targetHits: 14, falseTouches: 3, reactionOffsetMs});
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
