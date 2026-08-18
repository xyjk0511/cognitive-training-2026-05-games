import { canonicalSha256 } from "../../canonical.js";
import { CATCH_LIGHT_VERTICAL_SLICE_CONFIG, levelConfig } from "./config.js";
import { generateBatchSchedule } from "./generator.js";
import { CatchLightSession } from "./session-engine.js";
import {
  BATCH_DURATION_MS,
  CATCH_LIGHT_CONFIG_SET_ID,
  CATCH_LIGHT_GENERATOR_VERSION,
  CATCH_LIGHT_QA_SEED,
  OPERATION_DURATION_MS,
  PLANNED_BATCH_COUNT,
  PROMPT_DURATION_MS,
  SESSION_DURATION_MS,
  type CatchLightEligibleBatch,
  type CatchLightGameResultDraft,
  type GeneratedBatchSchedule,
} from "./types.js";

export type HeadlessPolicy = "UPGRADE" | "HOLD" | "FAIL";

export interface HeadlessScenarioOptions {
  name: string;
  level: number;
  policy: HeadlessPolicy;
  eligibleBatchTarget: 0 | 1 | 7 | 8;
  sessionSeed?: number;
}

export interface HeadlessScenarioResult {
  name: string;
  level: number;
  policy: HeadlessPolicy;
  eligibleBatchTarget: number;
  batchEvents: CatchLightEligibleBatch[];
  payload: CatchLightGameResultDraft;
}

function ceilRatio(value: number, numerator: number, denominator: number): number {
  return Math.floor((value * numerator + denominator - 1) / denominator);
}

function desiredCounts(policy: HeadlessPolicy, T: number, D: number): {H:number; F:number} {
  if (policy === "UPGRADE") return {H: ceilRatio(T, 4, 5), F: D === 0 ? 0 : D === 5 ? 1 : 2};
  if (policy === "HOLD") return {H: ceilRatio(T, 7, 10), F: D === 0 ? 0 : D === 5 ? 2 : 3};
  return {H: Math.max(0, ceilRatio(T, 7, 10) - 1), F: 0};
}

function applyPolicyToCurrentBatch(session: CatchLightSession, policy: HeadlessPolicy): void {
  const batch = session.currentBatchRuntime;
  if (batch === null) throw new Error("headless policy requested without an active batch");
  const counts = desiredCounts(policy, batch.levelConfig.targetTotal, batch.levelConfig.distractorTotal);
  const targets = batch.schedule.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "TARGET").sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const distractors = batch.schedule.waves.flatMap(wave => wave.instances).filter(instance => instance.role === "DISTRACTOR").sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const events: Array<{activeMs:number; instanceId:string}> = [];
  for (const instance of targets.slice(0, counts.H)) {
    const first = batch.operationStartActiveMs + instance.activeStartMs;
    events.push({activeMs:first, instanceId:instance.instanceId});
    if (instance.isDouble) events.push({activeMs:first + 1, instanceId:instance.instanceId});
  }
  for (const instance of distractors.slice(0, counts.F)) {
    events.push({activeMs:batch.operationStartActiveMs + instance.activeStartMs, instanceId:instance.instanceId});
  }
  if (batch.operationStartActiveMs < SESSION_DURATION_MS) {
    session.touchBlank(Math.min(SESSION_DURATION_MS - 1, batch.operationStartActiveMs + Math.min(100, OPERATION_DURATION_MS - 1)));
  }
  events.sort((a, b) => a.activeMs - b.activeMs || a.instanceId.localeCompare(b.instanceId));
  for (const event of events) {
    if (event.activeMs < SESSION_DURATION_MS) session.touchInstance(event.instanceId, event.activeMs);
  }
}

function delaysForEligibleCount(count: 0 | 1 | 7 | 8): number[] {
  const delays = new Array<number>(PLANNED_BATCH_COUNT).fill(0);
  if (count === 0) delays[0] = 262501;
  if (count === 1) delays[1] = 262499;
  if (count === 7) delays[7] = 1;
  return delays;
}

function plannedStarts(delays: readonly number[]): number[] {
  const starts: number[] = [];
  let start = delays[0] ?? 0;
  for (let ordinal = 1; ordinal <= PLANNED_BATCH_COUNT; ordinal += 1) {
    starts.push(start);
    start += BATCH_DURATION_MS + (delays[ordinal] ?? 0);
  }
  return starts;
}

export function runHeadlessScenario(options: HeadlessScenarioOptions): HeadlessScenarioResult {
  const batchEvents: CatchLightEligibleBatch[] = [];
  const delays = delaysForEligibleCount(options.eligibleBatchTarget);
  const runtimeConfigHash = canonicalSha256({
    gameConfigSchemaId: "urn:a620:catch-light:config:1.5",
    gameConfig: CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
    sessionStartLevel: options.level,
    sessionSeed: options.sessionSeed ?? CATCH_LIGHT_QA_SEED,
  });
  const session = new CatchLightSession({
    gameConfig: CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
    runtimeConfigHash,
    sessionSeed: options.sessionSeed ?? CATCH_LIGHT_QA_SEED,
    sessionStartLevel: options.level,
    batchStartDelaysMs: delays,
    onBatchClosed: batch => batchEvents.push(batch),
  });

  for (const start of plannedStarts(delays)) {
    if (start >= SESSION_DURATION_MS) break;
    session.advanceToActive(start);
    const batch = session.currentBatchRuntime;
    if (batch === null || batch.batchStartActiveMs !== start) throw new Error(`expected headless batch at ${start}`);
    applyPolicyToCurrentBatch(session, options.policy);
    if (batch.closeAtActiveMs <= SESSION_DURATION_MS) session.advanceToActive(batch.closeAtActiveMs);
    else break;
  }
  session.deadline();
  const payload = session.buildResultDraft();
  if (payload.eligibleBatchCount !== options.eligibleBatchTarget) {
    throw new Error(`${options.name}: expected ${options.eligibleBatchTarget} eligible batches, got ${payload.eligibleBatchCount}`);
  }
  return {
    name: options.name,
    level: options.level,
    policy: options.policy,
    eligibleBatchTarget: options.eligibleBatchTarget,
    batchEvents,
    payload,
  };
}

export interface CatchLightGoldenVector {
  level: number;
  sessionSeed: number;
  batchOrdinal: 1;
  schedule: GeneratedBatchSchedule;
  vectorSha256: string;
}

export interface CatchLightGoldenVectorFile {
  goldenVersion: "A620-CATCH-LIGHT-GOLDEN-1";
  generatorVersion: typeof CATCH_LIGHT_GENERATOR_VERSION;
  configSetId: typeof CATCH_LIGHT_CONFIG_SET_ID;
  qaSeed: typeof CATCH_LIGHT_QA_SEED;
  vectors: CatchLightGoldenVector[];
}

export function buildGoldenVectors(): CatchLightGoldenVectorFile {
  const vectors = [1, 28, 67, 102, 120].map(level => {
    const schedule = generateBatchSchedule(levelConfig(level), CATCH_LIGHT_QA_SEED, 1);
    const projection = {level, sessionSeed:CATCH_LIGHT_QA_SEED, batchOrdinal:1 as const, schedule};
    return {...projection, vectorSha256:canonicalSha256(projection)};
  });
  return {
    goldenVersion: "A620-CATCH-LIGHT-GOLDEN-1",
    generatorVersion: CATCH_LIGHT_GENERATOR_VERSION,
    configSetId: CATCH_LIGHT_CONFIG_SET_ID,
    qaSeed: CATCH_LIGHT_QA_SEED,
    vectors,
  };
}

export function buildHeadlessEvidence(): HeadlessScenarioResult[] {
  return [
    runHeadlessScenario({name:"L1-HOLD-8",level:1,policy:"HOLD",eligibleBatchTarget:8}),
    runHeadlessScenario({name:"L28-HOLD-8",level:28,policy:"HOLD",eligibleBatchTarget:8}),
    runHeadlessScenario({name:"L102-HOLD-8",level:102,policy:"HOLD",eligibleBatchTarget:8}),
    runHeadlessScenario({name:"L120-UPGRADE-8",level:120,policy:"UPGRADE",eligibleBatchTarget:8}),
    runHeadlessScenario({name:"L28-HOLD-0",level:28,policy:"HOLD",eligibleBatchTarget:0}),
    runHeadlessScenario({name:"L28-HOLD-1",level:28,policy:"HOLD",eligibleBatchTarget:1}),
    runHeadlessScenario({name:"L28-HOLD-7",level:28,policy:"HOLD",eligibleBatchTarget:7}),
  ];
}
