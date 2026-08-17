// Generated from contracts/normative A620 runtime profiles.
// Do not edit by hand; run scripts/bootstrap_vectors.sh.

export const JSON_MAX_DEPTH = 64;
export const JSON_MAX_TOTAL_NODES = 50000;
export const JSON_MAX_OBJECT_MEMBERS = 2048;
export const JSON_MAX_ARRAY_ITEMS = 2048;
export const JSON_MAX_STRING_UTF8_BYTES = 262144;
export const JSON_MAX_OBJECT_KEY_UTF8_BYTES = 512;
export const JSON_MAX_TOTAL_STRING_UTF8_BYTES = 1572864;
export const IPC_FRAME_HEADER_BYTES = 4;
export const IPC_FRAME_MIN_PAYLOAD_BYTES = 2;
export const IPC_FRAME_MAX_PAYLOAD_BYTES = 2097152;
export const IPC_FRAME_MAX_FEED_CHUNK_BYTES = 8388608;
export const DELIVERY_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 5000] as const;
export const DELIVERY_RETRY_CAP_MS = 5000;
export const DELIVERY_MAX_SEEN_MESSAGE_IDS_PER_RUNTIME = 2048;
export const DELIVERY_MAX_PENDING_PER_RUNTIME = 4096;
export const DELIVERY_MAX_PENDING_BYTES_PER_RUNTIME = 16777216;
export const DELIVERY_RESPONSE_OBLIGATIONS = Object.freeze({
  "PREPARE": ["READY"],
  "START": ["COMMAND_ACCEPTED", "STARTED"],
  "PAUSE": ["COMMAND_ACCEPTED", "PAUSED"],
  "RESUME": ["COMMAND_ACCEPTED", "RESUMED"],
  "TERMINATE": ["COMMAND_ACCEPTED", "TERMINATED"],
  "QUERY_STATE": ["STATE_SNAPSHOT"],
  "RESULT_READY": ["ACK_RESULT_COMMITTED"]
});
export const DELIVERY_RETAIN_UNTIL_RESULT_COMMITTED = ["BATCH_CLOSED"] as const;
export const WATCHDOG_TIMEOUTS_MS = Object.freeze({
  "prepareReady": 10000,
  "commandAccepted": 100,
  "startConfirmationAfterBoundary": 1000,
  "pauseConfirmationAfterBoundary": 1000,
  "resumeConfirmationAfterBoundary": 1000,
  "terminateConfirmationAfterBoundary": 1000,
  "queryState": 1000,
  "heartbeatInterval": 1000,
  "heartbeatSilence": 3500,
  "finalizationResultReady": 5000,
  "localResultCommit": 5000
});
export const WATCHDOG_SNAPSHOT_VERSION = "A620-RWS-1.1";
export const AUDIT_CHAIN_PROFILE_ID = "A620-RAC-1";
export const AUDIT_CHAIN_GENESIS_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";
export const AUDIT_CHAIN_ENTRY_PROJECTION = ["auditProfile", "journalIndex", "messageId", "runtimeSessionId", "senderRole", "senderSeq", "sentAtUptimeMs", "canonicalSha256", "disposition", "previousEntrySha256"] as const;
export const AUDIT_CHAIN_MIGRATION_KEY = "runtimeAuditChainProfile";
export const AUDIT_CHAIN_MIGRATION_VALUE = "A620-RAC-1";
