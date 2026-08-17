#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build/kotlin"
kotlinc "$ROOT/kotlin/src/main/kotlin/a620/"*.kt "$ROOT/kotlin/src/test/kotlin/a620/"*.kt -include-runtime -d "$ROOT/build/kotlin/gate0-tests.jar"
java -jar "$ROOT/build/kotlin/gate0-tests.jar" "$ROOT/contracts/test-vectors/canonical_json_vectors.json"
