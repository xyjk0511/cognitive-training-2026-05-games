import type {
  A620InteractiveTrainingGameModule,
  TrainingPointerEvent,
} from "../../game-plugin.js";
import type { EligibleBatch, GameResultDraft } from "../../contracts.js";
import { CatchLightGameModule } from "../../games/catch-light/adapter.js";
import {
  CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
  CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256,
} from "../../games/catch-light/config.js";
import { SignalStationTrainingGameModule } from "../../games/signal-station/adapter/training-game-module.js";
import { VERTICAL_SLICE_RUNTIME_CONFIG } from "../../games/signal-station/config/vertical-slices.js";
import { canonicalSha256 } from "../../canonical.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertBatchReconciliation(delivered: readonly EligibleBatch[], draft: GameResultDraft, label: string): void {
  assertEqual(delivered.length, draft.eligibleBatches.length, `${label} delivered/final batch count`);
  for (let index = 0; index < delivered.length; index += 1) {
    const emitted = delivered[index];
    const finalized = draft.eligibleBatches[index];
    if (emitted === undefined || finalized === undefined) throw new Error(`${label} missing batch at ${index}`);
    assertEqual(emitted.batchOrdinal, finalized.batchOrdinal, `${label} batch ordinal ${index}`);
    assertEqual(emitted.batchPayloadSha256, finalized.batchPayloadSha256, `${label} batch hash ${index}`);
  }
}

async function verifyInteractiveModule(options: {
  label: string;
  module: A620InteractiveTrainingGameModule;
  prepareContext: Parameters<A620InteractiveTrainingGameModule["prepare"]>[0];
  startUptimeMs: number;
  cutoffUptimeMs: number;
  firstBatchBoundaryUptimeMs: number;
}): Promise<void> {
  const delivered: EligibleBatch[] = [];
  let rejectedAttempts = 0;
  options.module.setEvidenceSink(() => {
    rejectedAttempts += 1;
    throw new Error("SIMULATED_HOST_PERSIST_FAILURE");
  });
  await options.module.prepare(options.prepareContext);
  options.module.onStart(options.startUptimeMs, options.cutoffUptimeMs);

  let firstFailure: string | null = null;
  try {
    options.module.advanceToUptime(options.firstBatchBoundaryUptimeMs);
  } catch (error) {
    firstFailure = error instanceof Error ? error.message : String(error);
  }
  assertEqual(firstFailure, "SIMULATED_HOST_PERSIST_FAILURE", `${options.label} propagates durable sink failure`);
  assertEqual(rejectedAttempts, 1, `${options.label} attempts first evidence once`);

  options.module.setEvidenceSink(batch => delivered.push(batch));
  options.module.retryPendingBatchEvidence();
  assertEqual(delivered.length, 1, `${options.label} retries one pending batch`);

  const pointerDown: TrainingPointerEvent = Object.freeze({
    pointerEventId: `${options.label}-pointer-down-1`,
    pointerId: `${options.label}-pointer-1`,
    phase: "DOWN",
    sourceUptimeMs: options.firstBatchBoundaryUptimeMs + 1,
    xPx: 100,
    yPx: 200,
    hitToken: null,
  });
  options.module.onPointerEvent(pointerDown);
  options.module.onPointerEvent(pointerDown);
  options.module.onInputStreamsCancelled("PAUSE");

  options.module.onDeadline(options.cutoffUptimeMs);
  const draft = options.module.buildResultDraft();
  assertBatchReconciliation(delivered, draft, options.label);
  await options.module.dispose();
}

const catchLightModule = new CatchLightGameModule();
await verifyInteractiveModule({
  label: "catch-light",
  module: catchLightModule,
  prepareContext: {
    gameCode: "CATCH_LIGHT",
    sessionSeed: 620_101,
    sessionStartLevel: 1,
    durationMs: 300000,
    runtimeConfigHash: CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256,
    gameConfig: CATCH_LIGHT_VERTICAL_SLICE_CONFIG as unknown as Readonly<Record<string, unknown>>,
  },
  startUptimeMs: 0,
  cutoffUptimeMs: 300000,
  firstBatchBoundaryUptimeMs: 37500,
});

const signalStationModule = new SignalStationTrainingGameModule();
await verifyInteractiveModule({
  label: "signal-station",
  module: signalStationModule,
  prepareContext: {
    gameCode: "SIGNAL_STATION",
    sessionSeed: 620_102,
    sessionStartLevel: 1,
    durationMs: 300000,
    runtimeConfigHash: canonicalSha256(VERTICAL_SLICE_RUNTIME_CONFIG),
    gameConfig: VERTICAL_SLICE_RUNTIME_CONFIG as unknown as Readonly<Record<string, unknown>>,
  },
  startUptimeMs: 1000,
  cutoffUptimeMs: 301000,
  firstBatchBoundaryUptimeMs: 38500,
});

console.log("A620_CROSS_GAME_COMPANION_SPI_TESTS_PASS");
