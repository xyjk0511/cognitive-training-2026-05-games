#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
python3 tools/generate_coordination_profiles.py --check
PYTHONPATH="$HERE:$HERE/../python" python3 -m pytest -q tests
rm -rf typescript/build
tsc -p typescript/tsconfig.json
node typescript/build/typescript/test_profiles.js
rm -rf kotlin/build
mkdir -p kotlin/build
kotlinc generated/CoordinationProfiles.kt kotlin/TestProfiles.kt -include-runtime -d kotlin/build/baseline5-tests.jar
java -jar kotlin/build/baseline5-tests.jar
echo BASELINE5_HARDENING_TESTS_PASS
