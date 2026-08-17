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
    service = application.find("service")
    assert service is not None
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
    callback = (ANDROID / "app/src/main/aidl/com/a620/tablet/training/ITrainingRuntimeCallback.aidl").read_text()
    assert "oneway interface ITrainingRuntimeCallback" in callback
    assert "ParcelFileDescriptor payloadFd" in callback


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
    assert "channelGeneration == generation && callbackBinder === newBinder" in text
    coordinator = (ANDROID / "app/src/main/java/com/a620/tablet/training/CanonicalIngressCoordinator.kt").read_text()
    assert coordinator.count("requireLiveGeneration(generation)") >= 3
    assert "ownedFd.close()" in coordinator
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
