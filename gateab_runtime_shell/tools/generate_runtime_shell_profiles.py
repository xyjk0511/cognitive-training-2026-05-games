from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NORM = ROOT / "normative"
GEN = ROOT / "generated"
NAMES = (
    "android_runtime_shell_profile.json",
    "durable_storage.json",
    "result_commit.json",
)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def render() -> dict[Path, str]:
    profiles = {name: json.loads((NORM / name).read_text(encoding="utf-8")) for name in NAMES}
    hashes = {name: hashlib.sha256(canonical(value)).hexdigest() for name, value in profiles.items()}
    aggregate = hashlib.sha256(canonical(profiles)).hexdigest()

    py = (
        "# generated; do not edit\n"
        f"PROFILES={profiles!r}\n"
        f"PROFILE_SHA256_BY_NAME={hashes!r}\n"
        f"AGGREGATE_PROFILE_SHA256={aggregate!r}\n"
    )
    ts = (
        "// generated; do not edit\n"
        "export const PROFILES="
        + json.dumps(profiles, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + " as const;\n"
        + "export const PROFILE_SHA256_BY_NAME="
        + json.dumps(hashes, sort_keys=True, separators=(",", ":"))
        + " as const;\n"
        + f'export const AGGREGATE_PROFILE_SHA256="{aggregate}" as const;\n'
    )

    ars = profiles["android_runtime_shell_profile.json"]
    binder = ars["binder"]
    proc = ars["processIsolation"]
    gate = ars["inputGate"]
    auth = proc["channelAuthentication"]
    urgent_message_types_kt = ",".join(json.dumps(x) for x in binder["urgentMessageTypes"])
    droppable_message_types_kt = ",".join(json.dumps(x) for x in binder["droppableOnBackpressureMessageTypes"])
    dsp = profiles["durable_storage.json"]
    ob = dsp["outbox"]
    rcp = profiles["result_commit.json"]
    kt = f'''// generated; do not edit
package a620.shell.generated

object RuntimeShellProfiles {{
    const val ANDROID_SHELL_PROFILE = "{ars['profile']}"
    const val CANDIDATE_REVISION = "{ars['candidateRevision']}"
    const val WIRE_CONTRACT_VERSION = "{ars['wireContractVersion']}"
    const val CONTROLLER_PROCESS = "{proc['controllerProcess']}"
    const val TRAINING_PROCESS_SUFFIX = "{proc['trainingProcessSuffix']}"
    const val STATUS = "{ars['status']}"
    const val SERVICE_EXPORTED = {str(proc['serviceExported']).lower()}
    const val SAME_UID_REQUIRED = {str(proc['sameUidRequired']).lower()}
    const val AUTO_RESUME_AFTER_PROCESS_DEATH = {str(proc['autoResumeAfterProcessDeath']).lower()}
    const val DEATH_OUTCOME = "{proc['deathOutcome']}"
    const val NEW_ATTEMPT_REQUIRED_AFTER_DEATH = {str(proc['newExecutionAttemptRequiredAfterDeath']).lower()}
    const val CALLBACK_REGISTRATION_TIMEOUT_MS: Long = {proc['callbackRegistrationTimeoutMs']}L
    const val CHANNEL_AUTH_PROFILE = "{auth['profile']}"
    const val CHANNEL_TOKEN_BYTES: Int = {auth['tokenBytes']}
    const val CHANNEL_TOKEN_CHARS: Int = {auth['tokenChars']}
    const val CHANNEL_TOKEN_ENCODING = "{auth['tokenEncoding']}"
    const val CHANNEL_TOKEN_ON_EVERY_AIDL_CALL = {str(auth['includeOnEveryAidlCall']).lower()}
    const val CHANNEL_TOKEN_ON_EVERY_CALLBACK = {str(auth['includeOnEveryCallback']).lower()}
    const val CHANNEL_TOKEN_PERSISTS_RAW = {str(auth['servicePersistsRawToken']).lower()}
    const val CHANNEL_TOKEN_RETAIN_RAW_IN_MEMORY_FOR_CALLBACKS = {str(auth['serviceRetainsRawTokenInMemoryForCallbacks']).lower()}
    const val CHANNEL_TOKEN_CONSTANT_TIME_COMPARE = {str(auth['constantTimeComparison']).lower()}
    const val INLINE_CANONICAL_MAX_BYTES: Int = {binder['inlineCanonicalMaxBytes']}
    const val INLINE_DESCRIPTOR_MAX_BYTES: Int = {binder['inlineDescriptorMaxBytes']}
    const val BULK_CANONICAL_MAX_BYTES: Int = {binder['bulkCanonicalMaxBytes']}
    const val BULK_LEASE_MS: Long = {binder['bulkLeaseMs']}L
    const val ACTOR_QUEUE_MAX_MESSAGES: Int = {binder['singleConsumerQueueMaxMessages']}
    const val ACTOR_QUEUE_MAX_BYTES: Int = {binder['singleConsumerQueueMaxBytes']}
    const val URGENT_QUEUE_MAX_MESSAGES: Int = {binder['urgentQueueMaxMessages']}
    const val URGENT_QUEUE_MAX_BYTES: Int = {binder['urgentQueueMaxBytes']}
    const val NORMAL_QUEUE_MAX_MESSAGES: Int = {binder['normalQueueMaxMessages']}
    const val NORMAL_QUEUE_MAX_BYTES: Int = {binder['normalQueueMaxBytes']}
    const val PRESERVE_INGRESS_ORDER_ACROSS_RESERVED_LANES = {str(binder['preserveIngressOrderAcrossReservedLanes']).lower()}
    const val BULK_IO_WORKERS: Int = {binder['bulkIoWorkers']}
    const val BULK_IO_QUEUE_MAX_MESSAGES: Int = {binder['bulkIoQueueMaxMessages']}
    const val MAX_INFLIGHT_BULK_MESSAGES: Int = {binder['maxInflightBulkMessages']}
    const val MAX_INFLIGHT_BULK_BYTES: Int = {binder['maxInflightBulkBytes']}
    const val BULK_READ_TIMEOUT_MS: Long = {binder['bulkReadTimeoutMs']}L
    const val STRICT_CANONICAL_ENVELOPE_REQUIRED = {str(binder['strictCanonicalEnvelopeRequired']).lower()}
    const val COMPARE_AIDL_IDENTITY_TO_ENVELOPE = {str(binder['compareAidlIdentityToEnvelope']).lower()}
    val URGENT_MESSAGE_TYPES: Set<String> = setOf({urgent_message_types_kt})
    val DROPPABLE_ON_BACKPRESSURE_MESSAGE_TYPES: Set<String> = setOf({droppable_message_types_kt})
    const val ONEWAY_SUBMISSION = {str(binder['onewaySubmission']).lower()}
    const val DUPLICATE_FD_BEFORE_ASYNC_USE = {str(binder['duplicateFileDescriptorBeforeAsyncUse']).lower()}
    const val INPUT_CLOCK_PROFILE = "{gate['clockProfile']}"
    const val INPUT_INTERVAL = "{gate['interval']}"
    const val MAX_POINTERS: Int = {gate['maxPointers']}
    const val REJECT_UNKNOWN_POINTER_UP = {str(gate['rejectUnknownPointerUp']).lower()}
    const val CANCEL_ACTIVE_STREAM_ON_BOUNDARY = {str(gate['cancelActiveStreamOnBoundary']).lower()}
    const val FORWARD_PLATFORM_CANCEL = {str(gate['forwardPlatformCancel']).lower()}

    const val ANDROID_GRADLE_PLUGIN = "{ars['toolchainCandidate']['androidGradlePlugin']}"
    const val GRADLE = "{ars['toolchainCandidate']['gradle']}"
    const val JDK: Int = {ars['toolchainCandidate']['jdk']}
    const val JDK_MINIMUM: Int = {ars['toolchainCandidate'].get('jdkMinimum', ars['toolchainCandidate']['jdk'])}
    const val JDK_STUB_TESTED: Int = {ars['toolchainCandidate'].get('jdkTestedByStub', ars['toolchainCandidate']['jdk'])}
    const val COMPILE_SDK: Int = {ars['toolchainCandidate']['compileSdk']}
    const val TARGET_SDK: Int = {ars['toolchainCandidate']['targetSdk']}
    const val MIN_SDK: Int = {ars['toolchainCandidate']['minSdk']}
    const val BUILD_TOOLS = "{ars['toolchainCandidate']['buildTools']}"

    const val STORAGE_PROFILE = "{dsp['profile']}"
    const val STORAGE_SCHEMA_VERSION: Int = {dsp['schemaVersion']}
    const val MAX_NORMAL_MESSAGES_PER_RUNTIME: Int = {ob['maxNormalMessagesPerRuntime']}
    const val MAX_NORMAL_BYTES_PER_RUNTIME: Int = {ob['maxNormalBytesPerRuntime']}
    const val CRITICAL_RESERVE_MESSAGES_PER_RUNTIME: Int = {ob['criticalReserveMessagesPerRuntime']}
    const val CRITICAL_RESERVE_BYTES_PER_RUNTIME: Int = {ob['criticalReserveBytesPerRuntime']}
    const val RESULT_COMMIT_PROFILE = "{rcp['profile']}"

    const val ANDROID_PROFILE_SHA256 = "{hashes['android_runtime_shell_profile.json']}"
    const val STORAGE_PROFILE_SHA256 = "{hashes['durable_storage.json']}"
    const val RESULT_COMMIT_PROFILE_SHA256 = "{hashes['result_commit.json']}"
    const val AGGREGATE_PROFILE_SHA256 = "{aggregate}"
}}
'''
    android_compat_kt = f'''// generated; do not edit
package a620.shell

/** Compatibility view over A620-ARS-1. */
object AndroidShellProfile {{
    const val Profile = "{ars['profile']}"
    const val CandidateRevision = "{ars['candidateRevision']}"
    const val WireContractVersion = "{ars['wireContractVersion']}"
    const val Status = "{ars['status']}"
    const val ProfileSha256 = "{hashes['android_runtime_shell_profile.json']}"

    const val InlineCanonicalMaxBytes = {binder['inlineCanonicalMaxBytes']}
    const val InlineDescriptorMaxBytes = {binder['inlineDescriptorMaxBytes']}
    const val BulkCanonicalMaxBytes = {binder['bulkCanonicalMaxBytes']}
    const val BulkLeaseMs = {binder['bulkLeaseMs']}L
    const val ActorQueueMaxMessages = {binder['singleConsumerQueueMaxMessages']}
    const val ActorQueueMaxBytes = {binder['singleConsumerQueueMaxBytes']}
    const val UrgentQueueMaxMessages = {binder['urgentQueueMaxMessages']}
    const val UrgentQueueMaxBytes = {binder['urgentQueueMaxBytes']}
    const val NormalQueueMaxMessages = {binder['normalQueueMaxMessages']}
    const val NormalQueueMaxBytes = {binder['normalQueueMaxBytes']}
    const val PreserveIngressOrderAcrossReservedLanes = {str(binder['preserveIngressOrderAcrossReservedLanes']).lower()}
    const val BulkIoWorkers = {binder['bulkIoWorkers']}
    const val BulkIoQueueMaxMessages = {binder['bulkIoQueueMaxMessages']}
    const val MaxInflightBulkMessages = {binder['maxInflightBulkMessages']}
    const val MaxInflightBulkBytes = {binder['maxInflightBulkBytes']}
    const val BulkReadTimeoutMs = {binder['bulkReadTimeoutMs']}L
    const val StrictCanonicalEnvelopeRequired = {str(binder['strictCanonicalEnvelopeRequired']).lower()}
    const val CompareAidlIdentityToEnvelope = {str(binder['compareAidlIdentityToEnvelope']).lower()}
    val UrgentMessageTypes: Set<String> = setOf({urgent_message_types_kt})
    val DroppableOnBackpressureMessageTypes: Set<String> = setOf({droppable_message_types_kt})
    const val SameUidRequired = {str(proc['sameUidRequired']).lower()}
    const val OnewaySubmission = {str(binder['onewaySubmission']).lower()}
    const val DuplicateFdBeforeAsyncUse = {str(binder['duplicateFileDescriptorBeforeAsyncUse']).lower()}

    const val InputClockProfile = "{gate['clockProfile']}"
    const val InputInterval = "{gate['interval']}"
    const val MaxPointers = {gate['maxPointers']}
    const val RejectUnknownPointerUp = {str(gate['rejectUnknownPointerUp']).lower()}
    const val CancelActiveStreamOnBoundary = {str(gate['cancelActiveStreamOnBoundary']).lower()}
    const val ForwardPlatformCancel = {str(gate['forwardPlatformCancel']).lower()}

    const val TrainingProcessSuffix = "{proc['trainingProcessSuffix']}"
    const val ServiceExported = {str(proc['serviceExported']).lower()}
    const val AutoResumeAfterProcessDeath = {str(proc['autoResumeAfterProcessDeath']).lower()}
    const val DeathOutcome = "{proc['deathOutcome']}"
    const val NewExecutionAttemptRequiredAfterDeath = {str(proc['newExecutionAttemptRequiredAfterDeath']).lower()}
    const val CallbackRegistrationTimeoutMs = {proc['callbackRegistrationTimeoutMs']}L
    const val ChannelAuthProfile = "{auth['profile']}"
    const val ChannelTokenBytes = {auth['tokenBytes']}
    const val ChannelTokenChars = {auth['tokenChars']}
    const val ChannelTokenPersistsRaw = {str(auth['servicePersistsRawToken']).lower()}
    const val ChannelTokenRetainRawInMemoryForCallbacks = {str(auth['serviceRetainsRawTokenInMemoryForCallbacks']).lower()}
    const val ChannelTokenConstantTimeCompare = {str(auth['constantTimeComparison']).lower()}
}}
'''

    android_runtime_policy_kt = f'''// generated; do not edit
package com.a620.tablet.training

object RuntimePolicy {{
    const val PROFILE = "{ars['profile']}"
    const val CONTRACT_VERSION = "{ars['wireContractVersion']}"
    const val PROFILE_SHA256 = "{hashes['android_runtime_shell_profile.json']}"
    const val INLINE_CANONICAL_MAX_BYTES = {binder['inlineCanonicalMaxBytes']}
    const val BULK_CANONICAL_MAX_BYTES = {binder['bulkCanonicalMaxBytes']}
    const val ACTOR_QUEUE_MAX_MESSAGES = {binder['singleConsumerQueueMaxMessages']}
    const val ACTOR_QUEUE_MAX_BYTES = {binder['singleConsumerQueueMaxBytes']}
    const val URGENT_QUEUE_MAX_MESSAGES = {binder['urgentQueueMaxMessages']}
    const val URGENT_QUEUE_MAX_BYTES = {binder['urgentQueueMaxBytes']}
    const val NORMAL_QUEUE_MAX_MESSAGES = {binder['normalQueueMaxMessages']}
    const val NORMAL_QUEUE_MAX_BYTES = {binder['normalQueueMaxBytes']}
    const val PRESERVE_INGRESS_ORDER_ACROSS_RESERVED_LANES = {str(binder['preserveIngressOrderAcrossReservedLanes']).lower()}
    const val BULK_IO_WORKERS = {binder['bulkIoWorkers']}
    const val BULK_IO_QUEUE_MAX_MESSAGES = {binder['bulkIoQueueMaxMessages']}
    const val MAX_INFLIGHT_BULK_MESSAGES = {binder['maxInflightBulkMessages']}
    const val MAX_INFLIGHT_BULK_BYTES = {binder['maxInflightBulkBytes']}
    const val BULK_READ_TIMEOUT_MS = {binder['bulkReadTimeoutMs']}L
    val URGENT_MESSAGE_TYPES: Set<String> = setOf({urgent_message_types_kt})
    val DROPPABLE_ON_BACKPRESSURE_MESSAGE_TYPES: Set<String> = setOf({droppable_message_types_kt})
    const val MAX_POINTERS = {gate['maxPointers']}
    const val CANCEL_ACTIVE_STREAM_ON_BOUNDARY = {str(gate['cancelActiveStreamOnBoundary']).lower()}
    const val FORWARD_PLATFORM_CANCEL = {str(gate['forwardPlatformCancel']).lower()}
    const val CALLBACK_REGISTRATION_TIMEOUT_MS = {proc['callbackRegistrationTimeoutMs']}L
    const val CHANNEL_AUTH_PROFILE = "{auth['profile']}"
    const val CHANNEL_TOKEN_BYTES = {auth['tokenBytes']}
    const val CHANNEL_TOKEN_CHARS = {auth['tokenChars']}
    const val CHANNEL_TOKEN_PERSISTS_RAW = {str(auth['servicePersistsRawToken']).lower()}
    const val CHANNEL_TOKEN_RETAIN_RAW_IN_MEMORY_FOR_CALLBACKS = {str(auth['serviceRetainsRawTokenInMemoryForCallbacks']).lower()}
    const val CHANNEL_TOKEN_CONSTANT_TIME_COMPARE = {str(auth['constantTimeComparison']).lower()}
    const val RECEIVER_CLOSES_INBOUND_PFD_AFTER_DUP = {str(binder['receiverClosesInboundPfdAfterSynchronousDuplication']).lower()}
    const val EXPOSE_RAW_AIDL_INTERFACE = {str(binder['exposeRawAidlInterfaceToCallers']).lower()}
}}
'''

    toolchain_lock = json.dumps({
        "profile": "A620-ANDROID-TOOLCHAIN-1",
        "candidateRevision": ars["candidateRevision"],
        "androidGradlePlugin": ars["toolchainCandidate"]["androidGradlePlugin"],
        "gradle": ars["toolchainCandidate"]["gradle"],
        "jdk": ars["toolchainCandidate"]["jdk"],
        "jdkMinimum": ars["toolchainCandidate"].get("jdkMinimum", ars["toolchainCandidate"]["jdk"]),
        "jdkStubTested": ars["toolchainCandidate"].get("jdkTestedByStub"),
        "compileSdk": ars["toolchainCandidate"]["compileSdk"],
        "targetSdk": ars["toolchainCandidate"]["targetSdk"],
        "minSdk": ars["toolchainCandidate"]["minSdk"],
        "buildTools": ars["toolchainCandidate"]["buildTools"],
        "gradleWrapperJarPresent": ars["sourceScaffold"]["gradleWrapperJarPresent"],
        "dependencyResolutionVerified": ars["sourceScaffold"]["dependencyResolutionVerified"],
        "androidSdkBuildVerified": ars["sourceScaffold"]["androidSdkBuildPerformed"],
        "candidateDeviceVerified": ars["sourceScaffold"]["deviceApprovalPerformed"],
        "reason": "The current build environment has neither Android SDK nor dependency-network access; JVM/stub compilation is not an Android SDK build.",
    }, indent=2, ensure_ascii=False) + "\n"

    return {
        GEN / "runtime_shell_profiles.py": py,
        GEN / "runtime_shell_profiles.ts": ts,
        GEN / "RuntimeShellProfiles.kt": kt,
        GEN / "profile.sha256": aggregate + "\n",
        ROOT / "typescript/src/generated-profile.ts": ts,
        ROOT / "kotlin/src/main/kotlin/a620/shell/generated/RuntimeShellProfiles.kt": kt,
        ROOT / "kotlin/src/main/kotlin/a620/shell/AndroidShellProfile.kt": android_compat_kt,
        ROOT / "android/app/src/main/java/com/a620/tablet/training/RuntimePolicy.kt": android_runtime_policy_kt,
        ROOT / "android/toolchain.lock.json": toolchain_lock,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs = render()
    if args.check:
        stale = [str(path) for path, content in outputs.items() if not path.exists() or path.read_text(encoding="utf-8") != content]
        if stale:
            raise SystemExit("generated files stale: " + ", ".join(stale))
        print("RUNTIME_SHELL_PROFILE_GENERATION_CHECK_PASS")
        return
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
    print("RUNTIME_SHELL_PROFILE_GENERATION_PASS")


if __name__ == "__main__":
    main()
