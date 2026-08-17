#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRIVATE_KEY_HEX="9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
mkdir -p "$ROOT/build/packages"
cd "$ROOT/python"
PYTHONPATH=. python3 tools/tpkg_cli.py build "$ROOT/packages/catch-light/content" "$ROOT/packages/catch-light/manifest.base.json" "$ROOT/build/packages/catch-light-gate0.tpkg" --private-key-hex "$PRIVATE_KEY_HEX"
PYTHONPATH=. python3 tools/tpkg_cli.py build "$ROOT/packages/signal-station/content" "$ROOT/packages/signal-station/manifest.base.json" "$ROOT/build/packages/signal-station-gate0.tpkg" --private-key-hex "$PRIVATE_KEY_HEX"
PYTHONPATH=. python3 tools/tpkg_cli.py validate "$ROOT/build/packages/catch-light-gate0.tpkg" "$ROOT/contracts/test-vectors/test_trust_store.json" >/dev/null
PYTHONPATH=. python3 tools/tpkg_cli.py validate "$ROOT/build/packages/signal-station-gate0.tpkg" "$ROOT/contracts/test-vectors/test_trust_store.json" >/dev/null
echo "SAMPLE_TPKG_BUILD_AND_VALIDATE_PASS"
