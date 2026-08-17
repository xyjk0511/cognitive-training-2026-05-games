from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROFILE = ROOT / "gateab_runtime_shell/normative/android_runtime_shell_profile.json"


def load_profile() -> dict:
    return json.loads(PROFILE.read_text(encoding="utf-8"))


def test_profile_budget_and_contract() -> None:
    p = load_profile()
    assert p["profile"] == "A620-ARS-1"
    assert p["candidateRevision"] == "rc3-baseline.7"
    assert p["wireContractVersion"] == "A620-TRC-1.1"
    assert p["status"] == "GATE_AB_RUNTIME_INGRESS_CANDIDATE_NOT_DEVICE_APPROVED"
    assert p["binder"]["inlineCanonicalMaxBytes"] == 49_152
    assert p["binder"]["inlineCanonicalMaxBytes"] < 64 * 1024
    assert p["binder"]["bulkCanonicalMaxBytes"] == 2 * 1024 * 1024
    assert p["binder"]["singleConsumerQueueMaxMessages"] == 96
    assert p["processIsolation"]["sameUidRequired"] is True
    assert p["binder"]["urgentQueueMaxMessages"] == 32
    assert p["binder"]["normalQueueMaxMessages"] == 64
    assert p["binder"]["urgentQueueMaxMessages"] + p["binder"]["normalQueueMaxMessages"] == 96
    assert p["binder"]["maxInflightBulkMessages"] == 4
    assert p["binder"]["bulkReadTimeoutMs"] == 15_000
    assert p["inputGate"]["cancelActiveStreamOnBoundary"] is True


def test_process_death_never_auto_resumes() -> None:
    p = load_profile()["processIsolation"]
    assert p["trainingProcessSuffix"] == ":training"
    assert p["serviceExported"] is False
    assert p["autoResumeAfterProcessDeath"] is False
    assert p["deathOutcome"] == "INTERRUPTED"
    assert p["newExecutionAttemptRequiredAfterDeath"] is True


def test_toolchain_is_explicit_but_not_claimed_as_built() -> None:
    p = load_profile()
    assert p["toolchainCandidate"] == {
        "androidGradlePlugin": "9.3.1",
        "gradle": "9.5.0",
        "jdk": 17,
        "compileSdk": 36,
        "targetSdk": 36,
        "minSdk": 30,
        "buildTools": "36.0.0",
    }
    assert p["sourceScaffold"]["androidSdkBuildPerformed"] is False
    assert p["sourceScaffold"]["deviceApprovalPerformed"] is False


def test_generated_profile_hash() -> None:
    p = load_profile()
    canonical = json.dumps(p, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(canonical).hexdigest()
    kt = (ROOT / "gateab_runtime_shell/kotlin/src/main/kotlin/a620/shell/generated/RuntimeShellProfiles.kt").read_text()
    ts = (ROOT / "gateab_runtime_shell/typescript/src/generated-profile.ts").read_text()
    assert digest in kt
    assert digest in ts


def test_reserved_urgent_bytes_can_admit_max_bulk_result() -> None:
    p = load_profile()["binder"]
    assert p["urgentQueueMaxBytes"] >= p["bulkCanonicalMaxBytes"]
    assert "RESULT_READY" in p["urgentMessageTypes"]
    assert "BATCH_CLOSED" in p["urgentMessageTypes"]
    assert set(p["droppableOnBackpressureMessageTypes"]) == {"HEARTBEAT", "STATE_SNAPSHOT"}
