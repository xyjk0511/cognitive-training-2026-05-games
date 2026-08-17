#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_step() {
    printf '\n==> %s\n' "$1"
    shift
    "$@"
}

# CI or the outer runner owns wall-clock cancellation. Nested GNU timeout
# wrappers caused orphaned Kotlin compiler processes in the staged delivery
# proof and made successful runs appear hung.
run_step gate0-python "$ROOT/scripts/test_python.sh"
run_step gate0-typescript "$ROOT/scripts/test_typescript.sh"
run_step gate0-kotlin "$ROOT/scripts/test_kotlin.sh"
run_step sample-training-packages "$ROOT/scripts/build_sample_packages.sh"
run_step baseline5-coordination "$ROOT/baseline5_hardening/scripts/test_baseline5_hardening.sh"
run_step baseline6-storage-integrity "$ROOT/baseline6_hardening/scripts/test_baseline6_hardening.sh"
run_step baseline8-gateab-authenticated-ingress "$ROOT/gateab_runtime_shell/tools/test_baseline8.sh"
echo ALL_GATE0_AND_GATEAB_BASELINE8_TESTS_PASS
