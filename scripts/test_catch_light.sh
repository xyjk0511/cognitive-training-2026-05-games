#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

printf '\n==> catch-light forbidden logic-source scan\n'
if grep -R -n -E 'Math\.random|Date\.now|setTimeout|setInterval' \
  "$ROOT/games/catch-light" "$ROOT/typescript/src/games/catch-light"; then
  echo "ERROR: forbidden random/clock/timer source found in Catch Light domain" >&2
  exit 2
fi
echo CATCH_LIGHT_FORBIDDEN_SOURCE_SCAN_PASS

printf '\n==> catch-light TypeScript build and domain tests\n'
(
  cd "$ROOT/typescript"
  npm run build
  node dist/test/catch-light/run-tests.js
)

printf '\n==> catch-light generated artifact freshness\n'
node "$ROOT/tools/catch-light/generate_artifacts.mjs" --check
python3 "$ROOT/tools/catch-light/build_schemas.py" --check

printf '\n==> catch-light JSON Schema and cross-field semantics\n'
PYTHONPATH="$ROOT/python" python3 "$ROOT/tools/catch-light/validate_artifacts.py"

echo CATCH_LIGHT_W2_ALL_TESTS_PASS
