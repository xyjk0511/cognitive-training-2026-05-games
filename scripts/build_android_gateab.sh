#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v npm >/dev/null || { echo "NPM_REQUIRED_FOR_ANDROID_GAME_BUNDLE" >&2; exit 22; }
(
  cd "$ROOT/typescript"
  if [[ ! -x node_modules/.bin/esbuild || ! -x node_modules/.bin/tsc ]]; then
    npm ci --silent
  fi
  npm run build --silent
  npm run build:android-training --silent
)

exec "$ROOT/gateab_runtime_shell/android/ci/android_sdk_preflight.sh"
