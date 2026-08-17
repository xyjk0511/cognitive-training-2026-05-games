#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$HERE"
python3 tools/generate_storage_profiles.py --check
PYTHONPATH="$REPO/baseline5_hardening:$REPO/python:$REPO" python3 -m pytest -q tests
rm -rf typescript/build
tsc -p typescript/tsconfig.json
node typescript/build/typescript/test_profiles.js
rm -rf kotlin/build
mkdir -p kotlin/build
kotlinc generated/StorageProfiles.kt kotlin/TestProfiles.kt -include-runtime -d kotlin/build/baseline6-tests.jar
java -jar kotlin/build/baseline6-tests.jar
echo BASELINE6_HARDENING_TESTS_PASS
