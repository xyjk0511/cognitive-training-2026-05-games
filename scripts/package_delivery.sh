#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
DATE_TAG="${DATE_TAG:-20260817}"
BASENAME="A620_Gate0_rc3_baseline1_${DATE_TAG}"
SOURCE_ZIP="$OUT_DIR/${BASENAME}_source.zip"
BUNDLE="$OUT_DIR/${BASENAME}_source.git.bundle"
PACKAGE_ZIP="$OUT_DIR/${BASENAME}_sample_training_packages.zip"
COMPLETE_ZIP="$OUT_DIR/${BASENAME}_complete_delivery.zip"
COMPONENT_CHECKSUMS="$OUT_DIR/${BASENAME}_component_SHA256SUMS.txt"
ALL_CHECKSUMS="$OUT_DIR/${BASENAME}_ALL_SHA256SUMS.txt"
DELIVERY_MANIFEST="$OUT_DIR/${BASENAME}_DELIVERY_MANIFEST.md"
TEST_LOG="$OUT_DIR/${BASENAME}_test_all.log"

mkdir -p "$OUT_DIR" "$ROOT/build/reports"
"$ROOT/scripts/bootstrap_vectors.sh"
set -o pipefail
"$ROOT/scripts/test_all.sh" 2>&1 | tee "$TEST_LOG"
cp "$TEST_LOG" "$ROOT/build/reports/test_all_${DATE_TAG}.txt"

if [[ -n "$(cd "$ROOT" && git status --porcelain)" ]]; then
    echo "Refusing to package a dirty working tree. Commit or revert tracked changes first." >&2
    (cd "$ROOT" && git status --short) >&2
    exit 1
fi

rm -f \
  "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$COMPLETE_ZIP" \
  "$COMPONENT_CHECKSUMS" "$ALL_CHECKSUMS" "$DELIVERY_MANIFEST"

python3 - "$ROOT" "$SOURCE_ZIP" <<'PY'
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

def zip_info(name: str, compression: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = compression
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.flag_bits |= 0x800
    return info

with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if any(part in excluded_dirs for part in rel.parts):
            continue
        if path.suffix in excluded_suffixes:
            continue
        archive_name = (Path(prefix) / rel).as_posix()
        zf.writestr(zip_info(archive_name, zipfile.ZIP_DEFLATED), path.read_bytes(), compresslevel=9)
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

def zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.flag_bits |= 0x800
    return info

with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as zf:
    for package in packages:
        zf.writestr(zip_info(package.name), package.read_bytes())
PY

python3 - "$COMPONENT_CHECKSUMS" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$TEST_LOG" <<'PY'
import hashlib
import sys
from pathlib import Path

out = Path(sys.argv[1])
paths = [Path(value) for value in sys.argv[2:]]
lines = []
for path in paths:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f"{digest}  {path.name}")
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

COMMIT="$(cd "$ROOT" && git rev-parse HEAD)"
BRANCH="$(cd "$ROOT" && git branch --show-current)"
TAG="$(cd "$ROOT" && git describe --tags --exact-match 2>/dev/null || true)"
[[ -n "$TAG" ]] || TAG="(no exact tag)"
PYTHON_VERSION="$(python3 --version 2>&1)"
NODE_VERSION="$(node --version 2>&1)"
KOTLIN_VERSION="$(kotlinc -version 2>&1 | head -n 1)"

cat > "$DELIVERY_MANIFEST" <<EOF_MANIFEST
# A620 Gate 0 rc3 baseline.1 交付清单

- 候选状态：\`GATE_0_IMPLEMENTATION_CANDIDATE_NOT_APPROVED\`
- Git 分支：\`$BRANCH\`
- Git 提交：\`$COMMIT\`
- Git 标签：\`$TAG\`
- 日期：\`$DATE_TAG\`

## 自动测试

\`34 passed / TYPESCRIPT_GATE0_TESTS_PASS / KOTLIN_GATE0_TESTS_PASS / SAMPLE_TPKG_BUILD_AND_VALIDATE_PASS\`

## 工具链

- $PYTHON_VERSION
- Node $NODE_VERSION
- $KOTLIN_VERSION

## 组件

- \`$(basename "$SOURCE_ZIP")\`：不含构建缓存的完整源码与规范；
- \`$(basename "$BUNDLE")\`：可离线还原全部 Git 引用的 bundle；
- \`$(basename "$PACKAGE_ZIP")\`：两份仅用于验证包格式的空插件样例训练包；
- \`$(basename "$TEST_LOG")\`：本次实际测试输出；
- \`$(basename "$COMPONENT_CHECKSUMS")\`：上述组件 SHA-256。

## 明确限制

本交付不包含 Android APK、Cocos Creator 工程、真实 AIDL/Binder、Room、原生触摸门、两款游戏代表等级、正式素材或生产密钥。它不能用于患者任务，也不能据此宣称 Gate 0 已通过。
EOF_MANIFEST

python3 - "$COMPLETE_ZIP" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$COMPONENT_CHECKSUMS" "$DELIVERY_MANIFEST" "$TEST_LOG" "$ROOT/docs/TEST_REPORT_20260817.md" <<'PY'
import sys
import zipfile
from pathlib import Path

out = Path(sys.argv[1])
inputs = [Path(value) for value in sys.argv[2:]]

def info(name: str, compression: int) -> zipfile.ZipInfo:
    item = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    item.compress_type = compression
    item.create_system = 3
    item.external_attr = 0o100644 << 16
    item.flag_bits |= 0x800
    return item

with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in inputs:
        compression = zipfile.ZIP_STORED if path.suffix in {".zip", ".bundle"} else zipfile.ZIP_DEFLATED
        zf.writestr(info(path.name, compression), path.read_bytes(), compresslevel=9 if compression == zipfile.ZIP_DEFLATED else None)
PY

python3 - "$ALL_CHECKSUMS" "$COMPLETE_ZIP" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$DELIVERY_MANIFEST" "$TEST_LOG" <<'PY'
import hashlib
import sys
from pathlib import Path

out = Path(sys.argv[1])
paths = [Path(value) for value in sys.argv[2:]]
lines = []
for path in paths:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f"{digest}  {path.name}")
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

unzip -t "$SOURCE_ZIP" >/dev/null
unzip -t "$PACKAGE_ZIP" >/dev/null
unzip -t "$COMPLETE_ZIP" >/dev/null

echo "$COMPLETE_ZIP"
echo "$SOURCE_ZIP"
echo "$BUNDLE"
echo "$PACKAGE_ZIP"
echo "$DELIVERY_MANIFEST"
echo "$ALL_CHECKSUMS"
