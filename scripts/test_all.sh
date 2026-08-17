#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STEP_TIMEOUT_SECONDS="${A620_TEST_TIMEOUT_SECONDS:-180}"

run_step() {
    timeout --foreground "$STEP_TIMEOUT_SECONDS" "$@"
}

run_step "$ROOT/scripts/test_python.sh"
run_step "$ROOT/scripts/test_typescript.sh"
run_step "$ROOT/scripts/test_kotlin.sh"
run_step "$ROOT/scripts/build_sample_packages.sh"
echo "ALL_GATE0_IMPLEMENTATION_TESTS_PASS"
