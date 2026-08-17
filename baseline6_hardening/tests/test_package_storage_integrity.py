from __future__ import annotations

import sqlite3

import pytest

from a620_coordination import (
    ClockRollback,
    PackageInstallCoordinator,
    PersistedDataCorruption,
    StaleFence,
)
from a620_coordination.sqlite_support import canonical_json_bytes, connect


def prepare_verified(coord, tmp_path, *, epoch_owner="installer", seq=1):
    lease = coord.acquire_lock(
        game_code="catch-light", owner_id=epoch_owner, now_ms=0, lease_ms=100,
    )
    plan = coord.begin_install(
        game_code="catch-light", owner_id=epoch_owner,
        fence_token=lease.fence_token, candidate_sha256="a" * 64,
        release_sequence=seq, staging_root=str(tmp_path), now_ms=1,
        install_id=f"install-{seq}",
    )
    coord.mark_staged(
        install_id=plan.install_id, owner_id=epoch_owner,
        fence_token=lease.fence_token, now_ms=2,
    )
    coord.mark_verified(
        install_id=plan.install_id, owner_id=epoch_owner,
        fence_token=lease.fence_token, manifest={"gameCode": "catch-light", "releaseSequence": seq},
        now_ms=3,
    )
    return lease, plan


def test_package_clock_rollback_is_rejected(tmp_path):
    coord = PackageInstallCoordinator(tmp_path / "pkg.db", monotonic_epoch_id="boot-1")
    coord.acquire_lock(game_code="catch-light", owner_id="a", now_ms=10)
    with pytest.raises(ClockRollback):
        coord.acquire_lock(game_code="signal-station", owner_id="b", now_ms=9)


def test_epoch_change_aborts_uncommitted_install_and_invalidates_old_owner(tmp_path):
    db = tmp_path / "pkg.db"
    old = PackageInstallCoordinator(db, monotonic_epoch_id="boot-1")
    lease, plan = prepare_verified(old, tmp_path)
    new = PackageInstallCoordinator(db, monotonic_epoch_id="boot-2")
    journal = new.journal(plan.install_id)
    assert journal["phase"] == "ABORTED"
    assert journal["abort_reason"] == "MONOTONIC_EPOCH_CHANGED"
    with pytest.raises(ClockRollback):
        old.commit_activation(
            install_id=plan.install_id, owner_id="installer",
            fence_token=lease.fence_token, now_ms=4,
        )


def test_active_manifest_corruption_is_detected_on_open(tmp_path):
    db = tmp_path / "pkg.db"
    coord = PackageInstallCoordinator(db, monotonic_epoch_id="boot-1")
    lease, plan = prepare_verified(coord, tmp_path)
    coord.commit_activation(
        install_id=plan.install_id, owner_id="installer",
        fence_token=lease.fence_token, now_ms=4,
    )
    conn = connect(db)
    try:
        conn.execute(
            "UPDATE package_active SET manifest_json=? WHERE game_code='catch-light'",
            (canonical_json_bytes({"gameCode": "evil"}),),
        )
    finally:
        conn.close()
    with pytest.raises(PersistedDataCorruption):
        PackageInstallCoordinator(db, monotonic_epoch_id="boot-1")


def test_active_pointer_must_equal_durable_floor(tmp_path):
    db = tmp_path / "pkg.db"
    coord = PackageInstallCoordinator(db, monotonic_epoch_id="boot-1")
    lease, plan = prepare_verified(coord, tmp_path)
    coord.commit_activation(
        install_id=plan.install_id, owner_id="installer",
        fence_token=lease.fence_token, now_ms=4,
    )
    conn = connect(db)
    try:
        conn.execute(
            "UPDATE package_release_floor SET minimum_release_sequence=2 "
            "WHERE game_code='catch-light'"
        )
    finally:
        conn.close()
    with pytest.raises(PersistedDataCorruption):
        coord.validate_integrity()
