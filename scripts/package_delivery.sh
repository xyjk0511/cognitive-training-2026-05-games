#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
DATE_TAG="${DATE_TAG:-20260817}"
DELIVERY_ZIP="$OUT_DIR/A620_Gate0_rc3_single_line_delivery_${DATE_TAG}.zip"
BUNDLE="$OUT_DIR/A620_Gate0_rc3_single_line_source_${DATE_TAG}.git.bundle"
PACKAGE_ZIP="$OUT_DIR/A620_Gate0_rc3_sample_training_packages_${DATE_TAG}.zip"
CHECKSUMS="$OUT_DIR/A620_Gate0_rc3_SHA256SUMS_${DATE_TAG}.txt"

mkdir -p "$OUT_DIR"
"$ROOT/scripts/test_all.sh"

rm -f "$DELIVERY_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$CHECKSUMS"

python3 - "$ROOT" "$DELIVERY_ZIP" <<'PY'
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
prefix = root.name
excluded_dirs = {
    ".git",
    "build",
    "node_modules",
    "dist",
    "__pycache__",
    ".pytest_cache",
}
excluded_suffixes = {".pyc", ".jar", ".class", ".tpkg", ".tmp"}

with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if any(part in excluded_dirs for part in rel.parts):
            continue
        if path.suffix in excluded_suffixes:
            continue
        zf.write(path, Path(prefix) / rel)
PY

(
    cd "$ROOT"
    git bundle create "$BUNDLE" --all
    git bundle verify "$BUNDLE" >/dev/null
)

python3 - "$ROOT" "$PACKAGE_ZIP" <<'PY'
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
packages = [
    root / "build/packages/catch-light-gate0.tpkg",
    root / "build/packages/signal-station-gate0.tpkg",
]
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as zf:
    for package in packages:
        zf.write(package, package.name)
PY

sha256sum \
    "$DELIVERY_ZIP" \
    "$BUNDLE" \
    "$PACKAGE_ZIP" \
    "$ROOT/build/packages/catch-light-gate0.tpkg" \
    "$ROOT/build/packages/signal-station-gate0.tpkg" \
    > "$CHECKSUMS"

unzip -t "$DELIVERY_ZIP" >/dev/null
unzip -t "$PACKAGE_ZIP" >/dev/null

echo "$DELIVERY_ZIP"
echo "$BUNDLE"
echo "$PACKAGE_ZIP"
echo "$CHECKSUMS"
