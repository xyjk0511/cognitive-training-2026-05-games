from __future__ import annotations

import concurrent.futures
import threading

import pytest

from a620_coordination import InstallBusy, PackageInstallCoordinator, StaleFence

def test_per_game_install_lock_and_stale_fence(tmp_path):
    coord = PackageInstallCoordinator(tmp_path / 'pkg.db')
    lease1 = coord.acquire_lock(game_code='catch-light', owner_id='installer-a', now_ms=0, lease_ms=100)
    with pytest.raises(InstallBusy):
        coord.acquire_lock(game_code='catch-light', owner_id='installer-b', now_ms=50, lease_ms=100)
    lease2 = coord.acquire_lock(game_code='catch-light', owner_id='installer-b', now_ms=100, lease_ms=100)
    assert lease2.fence_token == lease1.fence_token + 1
    plan = coord.begin_install(
        game_code='catch-light', owner_id='installer-b', fence_token=lease2.fence_token,
        candidate_sha256='b'*64, release_sequence=1, staging_root=str(tmp_path),
        now_ms=101, install_id='install-new',
    )
    with pytest.raises(StaleFence):
        coord.mark_staged(install_id=plan.install_id, owner_id='installer-a',
                          fence_token=lease1.fence_token, now_ms=102)

def test_different_games_can_install_concurrently(tmp_path):
    coord = PackageInstallCoordinator(tmp_path / 'pkg.db')
    a = coord.acquire_lock(game_code='catch-light', owner_id='a', now_ms=0)
    b = coord.acquire_lock(game_code='signal-station', owner_id='b', now_ms=0)
    assert a.fence_token == b.fence_token == 1

@pytest.mark.parametrize('fault_at', ['after_active_pointer','after_release_floor','before_commit'])
def test_activation_fault_rolls_back_pointer_floor_and_journal(tmp_path, fault_at):
    coord = PackageInstallCoordinator(tmp_path / 'pkg.db')
    lease = coord.acquire_lock(game_code='catch-light', owner_id='a', now_ms=0)
    plan = coord.begin_install(
        game_code='catch-light', owner_id='a', fence_token=lease.fence_token,
        candidate_sha256='a'*64, release_sequence=1, staging_root=str(tmp_path),
        now_ms=1, install_id='install-1',
    )
    coord.mark_staged(install_id=plan.install_id, owner_id='a', fence_token=lease.fence_token, now_ms=2)
    coord.mark_verified(install_id=plan.install_id, owner_id='a', fence_token=lease.fence_token,
                        manifest={'gameCode':'catch-light'}, now_ms=3)
    with pytest.raises(RuntimeError):
        coord.commit_activation(install_id=plan.install_id, owner_id='a',
                                fence_token=lease.fence_token, now_ms=4, fault_at=fault_at)
    assert coord.active('catch-light') is None
    assert coord.journal(plan.install_id)['phase'] == 'VERIFIED'
    active = coord.commit_activation(install_id=plan.install_id, owner_id='a',
                                     fence_token=lease.fence_token, now_ms=5)
    assert active['release_sequence'] == 1
    assert coord.journal(plan.install_id)['phase'] == 'COMMITTED'

def test_takeover_recovers_only_older_fence_staging(tmp_path):
    coord = PackageInstallCoordinator(tmp_path / 'pkg.db')
    first = coord.acquire_lock(game_code='catch-light', owner_id='a', now_ms=0, lease_ms=10)
    plan = coord.begin_install(
        game_code='catch-light', owner_id='a', fence_token=first.fence_token,
        candidate_sha256='1'*64, release_sequence=1, staging_root=str(tmp_path),
        now_ms=1, install_id='install-old',
    )
    second = coord.acquire_lock(game_code='catch-light', owner_id='b', now_ms=10, lease_ms=100)
    cleanup = coord.recover_abandoned(game_code='catch-light', owner_id='b',
                                      fence_token=second.fence_token, now_ms=11)
    assert cleanup == [plan.staging_path]
    assert coord.journal(plan.install_id)['phase'] == 'ABORTED'

def test_concurrent_activation_has_single_winner(tmp_path):
    coord = PackageInstallCoordinator(tmp_path / 'pkg.db')
    first = coord.acquire_lock(game_code='catch-light', owner_id='a', now_ms=0, lease_ms=10)
    p1 = coord.begin_install(
        game_code='catch-light', owner_id='a', fence_token=first.fence_token,
        candidate_sha256='1'*64, release_sequence=1, staging_root=str(tmp_path),
        now_ms=1, install_id='i1',
    )
    coord.mark_staged(install_id='i1', owner_id='a', fence_token=first.fence_token, now_ms=2)
    coord.mark_verified(install_id='i1', owner_id='a', fence_token=first.fence_token,
                        manifest={'v':1}, now_ms=3)
    second = coord.acquire_lock(game_code='catch-light', owner_id='b', now_ms=10, lease_ms=100)
    # Old fence can no longer commit. New owner explicitly abandons old staging.
    with pytest.raises(StaleFence):
        coord.commit_activation(install_id='i1', owner_id='a', fence_token=first.fence_token, now_ms=11)
    cleanup = coord.recover_abandoned(game_code='catch-light', owner_id='b',
                                      fence_token=second.fence_token, now_ms=12)
    assert coord.journal('i1')['phase'] == 'ABORTED'
    assert coord.quick_check() == 'ok'
