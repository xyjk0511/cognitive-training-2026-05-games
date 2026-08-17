from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_baseline6_is_implementation_revision_not_wire_fork() -> None:
    value = json.loads((ROOT / "gateab_runtime_shell/candidate_revision.json").read_text())
    assert value["contractVersion"] == "A620-TRC-1.1"
    assert value["implementationCandidateRevision"] == "rc3-baseline.6"
    assert value["inheritsWireBytesFrom"] == "rc3-baseline.5"
    assert value["wireSemanticChange"] is False
    assert "android_studio_source_scaffold" in value["scope"]
