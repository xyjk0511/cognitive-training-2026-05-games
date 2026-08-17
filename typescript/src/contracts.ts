export const CONTRACT_VERSION = "A620-TRC-1.1" as const;
export const CLOCK_PROFILE = "A620-UPTIME-MS-1" as const;
export const GAME_CODES = ["CATCH_LIGHT", "SIGNAL_STATION"] as const;
export type GameCode = typeof GAME_CODES[number];

export type RuntimeState =
  | "UNPREPARED" | "PREPARING" | "READY" | "START_SCHEDULED" | "RUNNING"
  | "PAUSE_SCHEDULED" | "PAUSED" | "RESUME_SCHEDULED" | "FINALIZING"
  | "RESULT_PENDING_COMMIT" | "RESULT_COMMITTED" | "TERMINATING" | "TERMINATED" | "ERROR";

export type SenderRole = "ANDROID_CONTROLLER" | "COCOS_RUNTIME";

export interface MessageEnvelope<P = unknown> {
  contractVersion: typeof CONTRACT_VERSION;
  messageType: string;
  messageId: string;
  correlationId: string | null;
  senderRole: SenderRole;
  senderSeq: number;
  sentAtUtc: string;
  sentAtUptimeMs: number;
  monotonicEpochId: string;
  systemId: string;
  deviceId: string;
  taskId: string;
  taskItemId: string;
  executionAttempt: number;
  runtimeSessionId: string;
  packageVersion: string;
  coreProtocolVersion: string;
  payload: P;
}

export interface EligibleBatch {
  batchOrdinal: number;
  closed: true;
  decisionEligible: true;
  levelBefore: number;
  resultZone: "UPGRADE" | "HOLD" | "FAIL";
  levelTransition: "UP" | "HOLD" | "RETRY" | "DOWN" | "HOLD_MAX" | "HOLD_MIN";
  levelAfter: number;
  batchScore: number;
  closedAtActiveMs: number;
  batchPayloadSha256: string;
  gameBatchMetrics: Record<string, unknown>;
}

export interface IncompleteBatchAudit {
  batchOrdinal: number;
  levelBefore: number;
  cutoffReason: "DEADLINE";
  startedAtActiveMs: number;
  cutoffAtActiveMs: 300000;
  partialMetrics: Record<string, unknown>;
}

export interface GameResultDraft {
  gameCode: GameCode;
  gamePayloadVersion: "A620-GP-1.1";
  runtimeConfigHash: string;
  designMaxLevel: number;
  plannedBatchCount: number;
  eligibleBatchCount: number;
  eligibleBatches: EligibleBatch[];
  incompleteBatchAudit: IncompleteBatchAudit[];
  sessionStartLevel: number;
  sessionEndLevel: number;
  sessionHighestPresentedLevel: number;
  sessionHighestPassedLevel: number | null;
  nextStartLevel: number;
  sessionRawScore: number;
  sessionRawScoreMax: number;
  actualTrainingMs: 300000;
  gameMetrics: Record<string, unknown>;
}
