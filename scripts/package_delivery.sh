#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
for stage in \
  prepare-core prepare-kotlin prepare-packages prepare-artifacts \
  verify-source-core verify-source-kotlin verify-source-tpkg \
  verify-bundle-core verify-bundle-kotlin verify-bundle-tpkg \
  assemble; do
    "$ROOT/scripts/package_delivery_staged.sh" "$OUT_DIR" "$stage"
done
