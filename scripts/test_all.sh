#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/test_python.sh"
"$ROOT/scripts/test_typescript.sh"
"$ROOT/scripts/test_kotlin.sh"
"$ROOT/scripts/build_sample_packages.sh"
echo "ALL_GATE0_IMPLEMENTATION_TESTS_PASS"
