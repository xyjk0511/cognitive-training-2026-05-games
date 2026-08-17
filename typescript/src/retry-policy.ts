import {
  DELIVERY_RESPONSE_OBLIGATIONS,
  DELIVERY_RETAIN_UNTIL_RESULT_COMMITTED,
  DELIVERY_RETRY_DELAYS_MS,
} from "./generated-runtime-profiles.js";

export const RETRY_DELAYS_MS = DELIVERY_RETRY_DELAYS_MS;
export const RESPONSE_OBLIGATIONS = DELIVERY_RESPONSE_OBLIGATIONS;
export const RETAIN_UNTIL_RESULT_COMMITTED = new Set<string>(
  DELIVERY_RETAIN_UNTIL_RESULT_COMMITTED,
);

export function retryDelayMs(completedAttempts: number): number {
  if (!Number.isSafeInteger(completedAttempts) || completedAttempts < 1) {
    throw new Error("completedAttempts must be a positive safe integer");
  }
  return RETRY_DELAYS_MS[Math.min(completedAttempts - 1, RETRY_DELAYS_MS.length - 1)]!;
}

export function requiredResponses(messageType: string): readonly string[] {
  return RESPONSE_OBLIGATIONS[messageType as keyof typeof RESPONSE_OBLIGATIONS] ?? [];
}

export function retainUntilResultCommitted(messageType: string): boolean {
  return RETAIN_UNTIL_RESULT_COMMITTED.has(messageType);
}
