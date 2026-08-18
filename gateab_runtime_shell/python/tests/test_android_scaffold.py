from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from xml.etree import ElementTree

import pytest

ROOT = Path(__file__).resolve().parents[3]
ANDROID = ROOT / "gateab_runtime_shell/android"
NS = "{http://schemas.android.com/apk/res/android}"


def test_manifest_has_one_entry_and_unexported_training_process() -> None:
    tree = ElementTree.parse(ANDROID / "app/src/main/AndroidManifest.xml")
    application = tree.getroot().find("application")
    assert application is not None
    launchers = []
    for activity in application.findall("activity"):
        for category in activity.findall("./intent-filter/category"):
            if category.attrib.get(NS + "name") == "android.intent.category.LAUNCHER":
                launchers.append(activity)
    assert len(launchers) == 1
    service = next(
        item
        for item in application.findall("service")
        if item.attrib.get(NS + "name") == ".training.TrainingRuntimeService"
    )
    assert service.attrib[NS + "exported"] == "false"
    assert service.attrib[NS + "process"] == ":training"


def test_aidl_uses_oneway_and_file_descriptor_for_bulk() -> None:
    text = (ANDROID / "app/src/main/aidl/com/a620/tablet/training/ITrainingRuntime.aidl").read_text()
    assert "oneway void submitInline" in text
    assert "oneway void submitBulk" in text
    assert "ParcelFileDescriptor payloadFd" in text
    assert "long byteLength" in text
    assert "String canonicalSha256" in text
    assert "String messageType" in text
    assert "String messageId" in text
    assert "long senderSeq" in text
    assert text.count("String channelToken") >= 4
    callback = (ANDROID / "app/src/main/aidl/com/a620/tablet/training/ITrainingRuntimeCallback.aidl").read_text()
    assert "oneway interface ITrainingRuntimeCallback" in callback
    assert "ParcelFileDescriptor payloadFd" in callback
    assert callback.count("String channelToken") >= 3


def test_service_enforces_same_uid_and_duplicates_fd() -> None:
    text = (ANDROID / "app/src/main/java/com/a620/tablet/training/TrainingRuntimeService.kt").read_text()
    assert "Binder.getCallingUid() != applicationInfo.uid" in text
    assert "CanonicalIngressCoordinator" in text
    assert "TrainingRuntimeActor" in text
    coordinator = (ANDROID / "app/src/main/java/com/a620/tablet/training/CanonicalIngressCoordinator.kt").read_text()
    assert "ParcelFileDescriptor.dup(payloadFd.fileDescriptor)" in coordinator
    assert "RuntimeWireEnvelopeParser.parseCanonical" in coordinator
    assert "bulkExecutor.execute" in coordinator
    assert "actor.submit" in coordinator
    assert coordinator.index("bulkExecutor.execute") < coordinator.index("actor.submit", coordinator.index("bulkExecutor.execute"))


def test_client_marks_process_death_interrupted_without_resume() -> None:
    text = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerRuntimeClient.kt").read_text()
    assert '"TRAINING_PROCESS_DIED"' in text
    assert "terminal.compareAndSet(false, true)" in text
    assert "terminal runtime requires a new execution attempt" in text
    assert "BIND_AUTO_CREATE" in text


def test_motion_event_uses_uptime_gate_and_explicit_cancel_stream() -> None:
    text = (ANDROID / "app/src/main/java/com/a620/tablet/training/AndroidTouchInputGate.kt").read_text()
    assert "eventTimeUptimeMs = event.eventTime" in text
    assert "CANCEL_STREAM" in text
    pure = (ROOT / "gateab_runtime_shell/kotlin/src/main/kotlin/a620/shell/PointerInputGate.kt").read_text()
    assert "sample.eventTimeUptimeMs < disabledAtUptimeMs" in pure
    assert "activePointers.clear()" in pure


def test_sql_schema_enforces_result_outcome_exclusivity() -> None:
    schema = (ANDROID / "app/schemas/runtime_store_v1.sql").read_text()
    db = sqlite3.connect(":memory:")
    db.executescript(schema)
    db.execute(
        "INSERT INTO runtime_session VALUES (?, ?, ?, ?, ?)",
        ("RUN-1", "ITEM-1", 1, "RUNNING", 0),
    )
    db.execute(
        "INSERT INTO formal_training_result VALUES (?, ?, ?, ?, ?)",
        ("RESULT-1", "RUN-1", "a" * 64, b"{}", 10),
    )
    with pytest.raises(sqlite3.IntegrityError, match="formal result"):
        db.execute(
            "INSERT INTO execution_outcome VALUES (?, ?, ?, ?)",
            ("RUN-1", "INTERRUPTED", "PROCESS_DIED", 11),
        )

    db.execute(
        "INSERT INTO runtime_session VALUES (?, ?, ?, ?, ?)",
        ("RUN-2", "ITEM-2", 1, "RUNNING", 0),
    )
    db.execute(
        "INSERT INTO execution_outcome VALUES (?, ?, ?, ?)",
        ("RUN-2", "INTERRUPTED", "PROCESS_DIED", 11),
    )
    with pytest.raises(sqlite3.IntegrityError, match="execution outcome"):
        db.execute(
            "INSERT INTO formal_training_result VALUES (?, ?, ?, ?, ?)",
            ("RESULT-2", "RUN-2", "b" * 64, b"{}", 12),
        )


def test_service_rechecks_generation_and_bulk_fd_is_owned_off_actor() -> None:
    text = (ANDROID / "app/src/main/java/com/a620/tablet/training/TrainingRuntimeService.kt").read_text()
    assert "channelGeneration == generation" in text
    assert "callbackBinder === newBinder" in text
    assert "MessageDigest.isEqual(channelTokenDigest, newDigest)" in text
    coordinator = (ANDROID / "app/src/main/java/com/a620/tablet/training/CanonicalIngressCoordinator.kt").read_text()
    assert coordinator.count("isLive(prepared.fence)") >= 2
    assert "CHANNEL_ROTATED_BEFORE_PARSE" in coordinator
    assert "CHANNEL_ROTATED_BEFORE_REDUCER" in coordinator
    assert "closeQuietly(operation.fd)" in coordinator
    assert "inFlightBulk" in coordinator
    assert "BULK_PAYLOAD_LEASE_EXPIRED" in coordinator


def test_client_ignores_old_binder_death_and_unbinds_only_if_bound() -> None:
    text = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerRuntimeClient.kt").read_text()
    assert "generation != currentGeneration" in text
    assert "currentBinder !== binder" in text
    assert "AtomicBoolean(false)" in text
    assert "if (bound)" in text


def test_android_runtime_policy_is_generated_from_normative_profile() -> None:
    profile = __import__("json").loads(
        (ROOT / "gateab_runtime_shell/normative/android_runtime_shell_profile.json").read_text()
    )
    text = (ANDROID / "app/src/main/java/com/a620/tablet/training/RuntimePolicy.kt").read_text()
    assert "// generated; do not edit" in text
    assert f'const val PROFILE = "{profile["profile"]}"' in text
    assert f'const val INLINE_CANONICAL_MAX_BYTES = {profile["binder"]["inlineCanonicalMaxBytes"]}' in text
    assert f'const val BULK_CANONICAL_MAX_BYTES = {profile["binder"]["bulkCanonicalMaxBytes"]}' in text
    assert f'const val ACTOR_QUEUE_MAX_MESSAGES = {profile["binder"]["singleConsumerQueueMaxMessages"]}' in text
    assert f'const val URGENT_QUEUE_MAX_MESSAGES = {profile["binder"]["urgentQueueMaxMessages"]}' in text
    assert f'const val MAX_INFLIGHT_BULK_MESSAGES = {profile["binder"]["maxInflightBulkMessages"]}' in text


def test_strict_parser_and_aidl_identity_cross_check_are_wired() -> None:
    parser = (ROOT / "kotlin/src/main/kotlin/a620/StrictCanonicalJson.kt").read_text()
    envelope = (ROOT / "kotlin/src/main/kotlin/a620/RuntimeWireEnvelope.kt").read_text()
    assert "duplicate object key" in parser
    assert "not A620-JCS-1 canonical bytes" in parser
    assert "AIDL messageType differs" in envelope
    assert "AIDL messageId differs" in envelope
    assert "AIDL senderSeq differs" in envelope


def test_priority_actor_has_reserved_urgent_lane() -> None:
    text = (ROOT / "gateab_runtime_shell/kotlin/src/main/kotlin/a620/shell/PriorityRuntimeActor.kt").read_text()
    assert "urgentMaxMessages" in text and "normalMaxMessages" in text
    assert "urgentHead.ordinal < normalHead.ordinal" in text
    assert "normal runtime actor capacity exceeded" in text


def test_android_toolchain_lock_is_explicit_and_not_falsely_verified() -> None:
    import json
    lock = json.loads((ANDROID / "toolchain.lock.json").read_text())
    assert lock["androidGradlePlugin"] == "9.3.1"
    assert lock["gradle"] == "9.5.0"
    assert lock["jdk"] == 17 and lock["compileSdk"] == 36
    assert lock["androidSdkBuildVerified"] is False
    preflight = (ANDROID / "ci/android_sdk_preflight.sh").read_text()
    assert ":app:assembleDebug" in preflight and ":app:lintDebug" in preflight


def test_android_apk_source_set_excludes_reference_only_harnesses() -> None:
    text = (ANDROID / "app/build.gradle.kts").read_text()
    for name in (
        "MockController.kt",
        "ControllerHarness.kt",
        "MockGame.kt",
        "RuntimeActor.kt",
        "RuntimeChannel.kt",
        "Transport.kt",
    ):
        assert name in text


def test_channel_token_is_generated_hashed_and_checked_on_both_directions() -> None:
    auth = (ANDROID / "app/src/main/java/com/a620/tablet/training/ChannelAuthenticator.kt").read_text()
    service = (ANDROID / "app/src/main/java/com/a620/tablet/training/TrainingRuntimeService.kt").read_text()
    client = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerRuntimeClient.kt").read_text()
    assert "SecureRandom" in auth
    assert "MessageDigest.isEqual" in auth
    assert "channelTokenDigest" in service
    assert "ChannelAuthenticator.matches" in service
    assert "ChannelAuthenticator.generateToken" in client
    assert "ChannelAuthenticator.matches" in client
    assert "fun requireRuntime" not in client


def test_receiver_closes_aidl_delivered_bulk_fd_after_coordinator_dup() -> None:
    service = (ANDROID / "app/src/main/java/com/a620/tablet/training/TrainingRuntimeService.kt").read_text()
    client = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerRuntimeClient.kt").read_text()
    assert "payloadFd.use { inbound" in service
    assert "payloadFd.use { inbound" in client
    coordinator = (ANDROID / "app/src/main/java/com/a620/tablet/training/CanonicalIngressCoordinator.kt").read_text()
    assert "ParcelFileDescriptor.dup(payloadFd.fileDescriptor)" in coordinator


def test_placeholder_sink_is_no_longer_wired_into_runtime_or_controller() -> None:
    service = (ANDROID / "app/src/main/java/com/a620/tablet/training/TrainingRuntimeService.kt").read_text()
    client = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerRuntimeClient.kt").read_text()
    interactive = (ANDROID / "app/src/main/java/com/a620/tablet/training/InteractiveTrainingRuntime.kt").read_text()
    sink = (ANDROID / "app/src/main/java/com/a620/tablet/training/RuntimeMessageSink.kt").read_text()
    assert "SwitchableRuntimeMessageSink" in service
    assert "InteractiveTrainingRuntime" in service
    assert "DeviceShellMockRuntime" not in service
    assert "StrictRuntimeMessageSink" in interactive
    assert "StrictRuntimeMessageSink" in client
    assert "RejectingPlaceholderSink" not in service
    assert "RejectingPlaceholderSink" not in client
    assert "senderSeq must strictly increase" in sink
    assert "runtime identity changed within one channel" in sink


def test_bulk_descriptors_are_closed_on_shutdown_and_stale_egress_is_not_fatal() -> None:
    ingress = (ANDROID / "app/src/main/java/com/a620/tablet/training/CanonicalIngressCoordinator.kt").read_text()
    egress = (ANDROID / "app/src/main/java/com/a620/tablet/training/RuntimeEventTransport.kt").read_text()
    assert "inFlightBulk" in ingress
    assert "operation.finished.compareAndSet(false, true)" in ingress
    assert "closeQuietly(operation.fd)" in ingress
    assert "activeWriteEnds" in egress
    assert "isCurrentChannel(channel)" in egress
    assert "if (!closed.get() && isCurrentChannel(channel))" in egress


def test_formal_result_replay_requires_exact_canonical_event() -> None:
    replay = (ANDROID / "app/src/main/java/com/a620/tablet/training/FormalResultReplayValidator.kt").read_text()
    store = (ANDROID / "app/src/main/java/com/a620/tablet/training/AndroidControllerStore.kt").read_text()
    sink = (ANDROID / "app/src/main/java/com/a620/tablet/training/DurableControllerEventSink.kt").read_text()
    assert "incomingCanonical.contentEquals(persistedResultReadyCanonical)" in replay
    assert "JOIN controller_event_inbox i ON i.message_id=f.result_ready_message_id" in store
    assert "loadCommittedAck(resultReady, canonicalResultReady)" in sink


def test_runtime_client_always_closes_ingress_when_interruption_persistence_fails():
    source = (ANDROID / "app/src/main/java/com/a620/tablet/training/ControllerRuntimeClient.kt").read_text()
    assert "private fun recordInterruptionAndClose" in source
    assert "finally {" in source
    assert "eventIngress.close()" in source
    assert "eventActor.shutdownNow()" in source
    assert "INTERRUPTION_PERSIST_FAILED" in source


def test_android_launcher_wires_both_real_game_modules_into_training_process() -> None:
    manifest = ElementTree.parse(ANDROID / "app/src/main/AndroidManifest.xml")
    application = manifest.getroot().find("application")
    assert application is not None
    training_activity = next(
        activity
        for activity in application.findall("activity")
        if activity.attrib.get(NS + "name") == ".training.TrainingActivity"
    )
    assert training_activity.attrib[NS + "exported"] == "false"
    assert training_activity.attrib[NS + "process"] == ":training"

    launcher = (ANDROID / "app/src/main/java/com/a620/tablet/MainActivity.kt").read_text()
    assert "CATCH_LIGHT" in launcher
    assert "SIGNAL_STATION" in launcher
    assert "startInteractiveExecution" in launcher
    assert "runtime_shell_status" not in launcher

    service = (ANDROID / "app/src/main/java/com/a620/tablet/training/TrainingRuntimeService.kt").read_text()
    assert "InteractiveTrainingRuntime" in service
    assert "DeviceShellMockRuntime(" not in service

    web_source = ROOT / "typescript/src/android-training/app.ts"
    assert web_source.is_file()
    text = web_source.read_text()
    assert "new CatchLightGameModule" in text
    assert "new SignalStationTrainingGameModule" in text
    assert "setEvidenceSink" in text
    assert "RESULT_READY" in text


def test_main_controller_stays_foreground_while_training_process_is_visible() -> None:
    tree = ElementTree.parse(ANDROID / "app/src/main/AndroidManifest.xml")
    root = tree.getroot()
    permissions = {item.attrib[NS + "name"] for item in root.findall("uses-permission")}
    assert "android.permission.FOREGROUND_SERVICE" in permissions
    assert "android.permission.FOREGROUND_SERVICE_SPECIAL_USE" in permissions
    application = root.find("application")
    assert application is not None
    keep_alive = next(
        service
        for service in application.findall("service")
        if service.attrib.get(NS + "name") == ".ControllerKeepAliveService"
    )
    assert keep_alive.attrib[NS + "exported"] == "false"
    assert keep_alive.attrib[NS + "foregroundServiceType"] == "specialUse"
    source = (ANDROID / "app/src/main/java/com/a620/tablet/ControllerKeepAliveService.kt").read_text()
    assert "startForeground" in source
    assert "durable controller" in source


def test_android_training_bundle_is_packaged_and_has_no_network_surface() -> None:
    gradle = (ANDROID / "app/build.gradle.kts").read_text()
    assert "training-runtime.bundle.js" in gradle
    assert "game-config" in gradle

    manifest = (ANDROID / "app/src/main/AndroidManifest.xml").read_text()
    assert "android.permission.INTERNET" not in manifest

    build_script = (ROOT / "scripts/build_android_gateab.sh").read_text()
    assert "npm run build:android-training" in build_script
    assert "npm ci" in build_script

    html = ANDROID / "app/src/main/assets/training/index.html"
    bundle = ANDROID / "app/src/main/assets/training/training-runtime.bundle.js"
    assert html.is_file()
    assert bundle.is_file()
    assert "training-runtime.bundle.js" in html.read_text()
    assert bundle.stat().st_size > 10_000
