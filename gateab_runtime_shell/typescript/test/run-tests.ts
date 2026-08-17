import { PROFILES, PROFILE_SHA256_BY_NAME } from "../src/generated-profile.js";
import { planCanonicalValue, profileProjectionHash, verifyBulkBytes } from "../src/transport-policy.js";
import { canonicalUtf8 } from "../../../typescript/src/canonical.js";


const androidShellProfile = PROFILES["android_runtime_shell_profile.json"];
const androidShellProfileSha256 = PROFILE_SHA256_BY_NAME["android_runtime_shell_profile.json"];

function check(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

check(androidShellProfile.profile === "A620-ARS-1", "profile");
check(androidShellProfile.candidateRevision === "rc3-baseline.8", "revision");
check(profileProjectionHash() === androidShellProfileSha256, "profile hash");
check(androidShellProfile.binder.urgentQueueMaxMessages === 32, "urgent queue reserve");
check(androidShellProfile.binder.normalQueueMaxMessages === 64, "normal queue cap");
check(androidShellProfile.inputGate.cancelActiveStreamOnBoundary === true, "touch cancel boundary");
check(androidShellProfile.processIsolation.channelAuthentication.profile === "A620-ACS-1", "channel auth profile");
check(androidShellProfile.processIsolation.channelAuthentication.tokenBytes === 32, "channel token bytes");
check(androidShellProfile.processIsolation.channelAuthentication.tokenChars === 64, "channel token chars");
check(androidShellProfile.processIsolation.channelAuthentication.persistRawToken === false, "raw token must not persist");
check(androidShellProfile.binder.droppableOnBackpressureMessageTypes.includes("HEARTBEAT"), "telemetry backpressure policy");
check(androidShellProfile.binder.urgentQueueMaxBytes >= androidShellProfile.binder.bulkCanonicalMaxBytes, "max result fits urgent reserve");

const inline = planCanonicalValue({ messageType: "HEARTBEAT", seq: 1 });
check(inline.kind === "INLINE", "small payload inline");

const largeValue = { payload: "x".repeat(androidShellProfile.binder.inlineCanonicalMaxBytes + 100) };
const bulk = planCanonicalValue(largeValue, "RESULT-1");
check(bulk.kind === "BULK_FD", "large payload bulk");
if (bulk.kind === "BULK_FD") {
  const bytes = canonicalUtf8(largeValue);
  verifyBulkBytes(bulk, bytes);
  const tampered = bytes.slice();
  const tamperIndex = tampered.length - 2;
  tampered[tamperIndex] = (tampered[tamperIndex] ?? 0) ^ 1;
  let rejected = false;
  try { verifyBulkBytes(bulk, tampered); } catch { rejected = true; }
  check(rejected, "tamper rejected");
}

let tooLargeRejected = false;
try {
  planCanonicalValue({ payload: "x".repeat(androidShellProfile.binder.bulkCanonicalMaxBytes + 1) });
} catch {
  tooLargeRejected = true;
}
check(tooLargeRejected, "oversize rejected");

console.log("TYPESCRIPT_BASELINE8_AUTHENTICATED_DURABLE_CONTROLLER_TESTS_PASS");
