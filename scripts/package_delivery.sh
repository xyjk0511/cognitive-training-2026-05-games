#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
for stage in prepare verify-source verify-bundle assemble; do
    "$ROOT/scripts/package_delivery_staged.sh" "$OUT_DIR" "$stage"
done
