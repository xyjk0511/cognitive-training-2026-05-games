from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NORM = ROOT / 'normative'
GENERATED = ROOT / 'generated'

def load_profiles():
    names = [
        'concurrency_control.json',
        'package_install_coordination.json',
        'retry_watchdog_coordination.json',
    ]
    return {name: json.loads((NORM / name).read_text(encoding='utf-8')) for name in names}

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def render():
    profiles = load_profiles()
    digest = hashlib.sha256(canonical(profiles)).hexdigest()
    py = '# generated; do not edit\nPROFILES = ' + repr(profiles) + f"\nPROFILE_SHA256 = {digest!r}\n"
    ts_json = json.dumps(profiles, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    ts = f"// generated; do not edit\nexport const PROFILES = {ts_json} as const;\nexport const PROFILE_SHA256 = {json.dumps(digest)};\n"
    cc = profiles['concurrency_control.json']
    pi = profiles['package_install_coordination.json']
    rw = profiles['retry_watchdog_coordination.json']
    kt = (
        "// generated; do not edit\n"
        "package a620.coordination.generated\n\n"
        "object CoordinationProfiles {\n"
        f"    const val CONCURRENCY_PROFILE = \"{cc['profile']}\"\n"
        f"    const val SQLITE_BUSY_TIMEOUT_MS: Long = {cc['sqlite']['busyTimeoutMs']}L\n"
        f"    const val RUNTIME_LEASE_MS: Long = {cc['runtimeLeaseMs']}L\n"
        f"    const val OUTBOX_CLAIM_LEASE_MS: Long = {cc['outboxClaimLeaseMs']}L\n"
        f"    const val INSTALL_PROFILE = \"{pi['profile']}\"\n"
        f"    const val INSTALL_LEASE_MS: Long = {pi['installLeaseMs']}L\n"
        f"    const val RETRY_WATCHDOG_PROFILE = \"{rw['profile']}\"\n"
        f"    const val DEADLINE_TIE_BREAKER = \"{rw['deadlineTieBreaker']}\"\n"
        f"    const val PROFILE_SHA256 = \"{digest}\"\n"
        "}\n"
    )
    return {
        GENERATED / 'coordination_profiles.py': py,
        GENERATED / 'coordination_profiles.ts': ts,
        GENERATED / 'CoordinationProfiles.kt': kt,
        GENERATED / 'profile.sha256': digest + '\n',
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    outputs = render()
    if args.check:
        bad = [str(p) for p, content in outputs.items() if not p.exists() or p.read_text(encoding='utf-8') != content]
        if bad:
            raise SystemExit('generated files stale: ' + ', '.join(bad))
        print('COORDINATION_PROFILE_GENERATION_CHECK_PASS')
        return
    GENERATED.mkdir(parents=True, exist_ok=True)
    for path, content in outputs.items():
        path.write_text(content, encoding='utf-8', newline='\n')
    print('COORDINATION_PROFILE_GENERATION_PASS')

if __name__ == '__main__':
    main()
