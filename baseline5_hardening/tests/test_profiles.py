from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def test_generated_profiles_are_current():
    subprocess.run(
        [sys.executable, str(ROOT / 'tools' / 'generate_coordination_profiles.py'), '--check'],
        check=True,
    )

def test_profile_hash_covers_all_normative_profiles():
    profiles = {
        p.name: json.loads(p.read_text(encoding='utf-8'))
        for p in sorted((ROOT / 'normative').glob('*.json'))
    }
    canonical = json.dumps(profiles, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    expected = hashlib.sha256(canonical).hexdigest()
    assert (ROOT / 'generated' / 'profile.sha256').read_text().strip() == expected
