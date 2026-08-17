from a620_runtime_shell import EmergencyReserve

def test_emergency_reserve_create_validate_release(tmp_path):
    p=tmp_path/'reserve.bin'; r=EmergencyReserve(p,65536)
    assert r.ensure() and p.stat().st_size==65536
    assert not r.ensure()
    assert r.release() and not p.exists()
    assert not r.release()

def test_emergency_reserve_size_mismatch_is_not_silently_replaced(tmp_path):
    p=tmp_path/'reserve.bin'; p.write_bytes(b'x')
    r=EmergencyReserve(p,65536)
    try: r.ensure()
    except RuntimeError: pass
    else: raise AssertionError('size mismatch must fail')
