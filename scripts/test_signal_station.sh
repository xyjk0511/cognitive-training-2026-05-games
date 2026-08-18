#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

printf '%s\n' '[signal-station] TypeScript strict build'
(
  cd "$ROOT/typescript"
  npm run build --silent
)

printf '%s\n' '[signal-station] domain, generator, scoring, headless and SPI adapter tests'
(
  cd "$ROOT/typescript"
  node dist/test/signal-station/run-tests.js
)

printf '%s\n' '[signal-station] generated asset reproducibility'
(
  cd "$ROOT/typescript"
  node dist/test/signal-station/emit-runtime-config.js > "$TMP_DIR/runtime-config.json"
  node dist/test/signal-station/emit-golden-vectors.js > "$TMP_DIR/vertical-slices.json"
)
cmp "$TMP_DIR/runtime-config.json" "$ROOT/games/signal-station/configs/vertical-slices/runtime-config.json"
cmp "$TMP_DIR/runtime-config.json" "$ROOT/packages/signal-station/content/config/runtime-config.json"
cmp "$TMP_DIR/vertical-slices.json" "$ROOT/games/signal-station/golden-vectors/vertical-slices.json"
cmp "$TMP_DIR/vertical-slices.json" "$ROOT/packages/signal-station/content/golden-vectors/vertical-slices.json"
echo 'SIGNAL_STATION_GENERATED_ASSETS_REPRODUCIBLE_PASS'

printf '%s\n' '[signal-station] schema, payload and canonical hash verification'
PYTHONPATH="$ROOT/python" python3 "$ROOT/tools/signal-station/verify_schema_assets.py"

printf '%s\n' '[signal-station] deterministic training package build and signature validation'
PRIVATE_KEY_HEX='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
mkdir -p "$ROOT/build/packages"
(
  cd "$ROOT/python"
  PYTHONPATH=. python3 tools/tpkg_cli.py build \
    "$ROOT/packages/signal-station/content" \
    "$ROOT/packages/signal-station/manifest.base.json" \
    "$ROOT/build/packages/signal-station-w3.tpkg" \
    --private-key-hex "$PRIVATE_KEY_HEX"
  PYTHONPATH=. python3 tools/tpkg_cli.py validate \
    "$ROOT/build/packages/signal-station-w3.tpkg" \
    "$ROOT/contracts/test-vectors/test_trust_store.json" >/dev/null
)
echo 'SIGNAL_STATION_TPKG_BUILD_AND_VALIDATE_PASS'

printf '%s\n' '[signal-station] forbidden nondeterministic APIs'
if grep -R -n -E 'Math\.random|Date\.now|new Date\(|performance\.now|crypto\.getRandomValues|crypto\.randomBytes|randomUUID|process\.(hrtime|uptime)|setTimeout|setInterval|requestAnimationFrame' \
  "$ROOT/games/signal-station" "$ROOT/typescript/src/games/signal-station"; then
  echo 'forbidden nondeterministic API found' >&2
  exit 1
fi
echo 'SIGNAL_STATION_NO_FORBIDDEN_TIME_OR_RANDOM_API_PASS'

printf '%s\n' '[signal-station] retired public event names'
if grep -R -n -E 'RESUME_COUNTDOWN|SESSION_COMPLETED|SESSION_FAILED|CUTOFF' \
  "$ROOT/games/signal-station" "$ROOT/packages/signal-station" "$ROOT/typescript/src/games/signal-station"; then
  echo 'retired public event name found' >&2
  exit 1
fi
echo 'SIGNAL_STATION_NO_RETIRED_EVENT_NAME_PASS'

echo 'SIGNAL_STATION_W3_TEST_SUITE_PASS'
