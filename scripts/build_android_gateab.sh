#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/gateab_runtime_shell/android/ci/android_sdk_preflight.sh"
