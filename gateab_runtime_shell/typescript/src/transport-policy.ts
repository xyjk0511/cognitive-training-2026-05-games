import { canonicalSha256, canonicalUtf8, sha256Hex } from "../../../typescript/src/canonical.js";
import { PROFILES } from "./generated-profile.js";

const androidShellProfile = PROFILES["android_runtime_shell_profile.json"];

export type InlinePlan = {
  readonly kind: "INLINE";
  readonly canonicalBytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
};

export type BulkPlan = {
  readonly kind: "BULK_FD";
  readonly payloadId: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export type TransportPlan = InlinePlan | BulkPlan;

export function planCanonicalValue(value: unknown, payloadId = "PAYLOAD"): TransportPlan {
  const bytes = canonicalUtf8(value);
  if (bytes.byteLength === 0 || bytes.byteLength > androidShellProfile.binder.bulkCanonicalMaxBytes) {
    throw new Error("canonical payload outside transport budget");
  }
  const digest = sha256Hex(bytes);
  if (bytes.byteLength <= androidShellProfile.binder.inlineCanonicalMaxBytes) {
    return { kind: "INLINE", canonicalBytes: bytes, byteLength: bytes.byteLength, sha256: digest };
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(payloadId)) throw new Error("invalid payloadId");
  return { kind: "BULK_FD", payloadId, byteLength: bytes.byteLength, sha256: digest };
}

export function verifyBulkBytes(plan: BulkPlan, bytes: Uint8Array): void {
  if (bytes.byteLength !== plan.byteLength) throw new Error("bulk length mismatch");
  if (sha256Hex(bytes) !== plan.sha256) throw new Error("bulk hash mismatch");
}

export function profileProjectionHash(): string {
  return canonicalSha256(androidShellProfile);
}
