#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

printf '[game-integration] strict TypeScript build\n'
(cd "$ROOT/typescript" && npm run build --silent)

printf '[game-integration] cross-game companion SPI and evidence reconciliation\n'
node "$ROOT/typescript/dist/test/game-integration/run-tests.js"
