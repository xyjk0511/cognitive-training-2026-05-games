#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
DATE_TAG="${DATE_TAG:-20260817}"
REHYDRATE_STEP_TIMEOUT_SECONDS="${A620_REHYDRATE_STEP_TIMEOUT_SECONDS:-180}"
BASENAME="A620_Gate0_rc3_baseline3_${DATE_TAG}"
EXPECTED_TAG="a620-trc-1.1-rc3-baseline.3"
SOURCE_ZIP="$OUT_DIR/${BASENAME}_source.zip"
BUNDLE="$OUT_DIR/${BASENAME}_source.git.bundle"
PACKAGE_ZIP="$OUT_DIR/${BASENAME}_sample_training_packages.zip"
COMPLETE_ZIP="$OUT_DIR/${BASENAME}_complete_delivery.zip"
COMPONENT_CHECKSUMS="$OUT_DIR/${BASENAME}_component_SHA256SUMS.txt"
ALL_CHECKSUMS="$OUT_DIR/${BASENAME}_ALL_SHA256SUMS.txt"
DELIVERY_MANIFEST="$OUT_DIR/${BASENAME}_DELIVERY_MANIFEST.md"
TEST_LOG="$OUT_DIR/${BASENAME}_test_all.log"
RAW_TEST_LOG="$ROOT/build/reports/test_all_${DATE_TAG}_raw.log"

mkdir -p "$OUT_DIR" "$ROOT/build/reports"
"$ROOT/scripts/bootstrap_vectors.sh"
set -o pipefail
"$ROOT/scripts/test_all.sh" 2>&1 | tee "$RAW_TEST_LOG"
python3 - "$RAW_TEST_LOG" "$TEST_LOG" "$ROOT" <<'PY_NORMALIZE'
from pathlib import Path
import re
import sys

raw = Path(sys.argv[1]).read_text(encoding="utf-8")
root = str(Path(sys.argv[3]).resolve())
# Remove wall-clock duration and checkout-specific absolute paths so the
# exported evidence log is stable across clean rehydration locations.
normalized = re.sub(r"(\d+ passed)(?:, \d+ warning(?:s)?)? in \d+(?:\.\d+)?s", r"\1", raw)
normalized = normalized.replace(root, "<REPO>")
Path(sys.argv[2]).write_text(normalized, encoding="utf-8")
PY_NORMALIZE
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

def zip_info(name: str, compression: int, executable: bool) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = compression
    info.create_system = 3
    info.external_attr = (0o100755 if executable else 0o100644) << 16
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
        executable = bool(path.stat().st_mode & 0o111)
        zf.writestr(zip_info(archive_name, zipfile.ZIP_DEFLATED, executable), path.read_bytes(), compresslevel=9)
PY

(
    cd "$ROOT"
    git bundle create "$BUNDLE" --all
    git bundle verify "$BUNDLE" >/dev/null
)

COMMIT="$(cd "$ROOT" && git rev-parse HEAD)"
BRANCH="$(cd "$ROOT" && git branch --show-current)"
TAG="$EXPECTED_TAG"
TAG_COMMIT="$(cd "$ROOT" && git rev-list -n 1 "$TAG" 2>/dev/null || true)"
if [[ "$TAG_COMMIT" != "$COMMIT" ]]; then
    echo "Expected delivery tag $TAG does not point to current commit $COMMIT." >&2
    exit 1
fi

VERIFY_DIR="$(mktemp -d)"
trap 'rm -rf "$VERIFY_DIR"' EXIT

run_rehydrated_suite() {
    local checkout_root="$1"
    local label="$2"
    (
        cd "$checkout_root"
        echo "${label}_BOOTSTRAP"
        timeout --foreground "$REHYDRATE_STEP_TIMEOUT_SECONDS" ./scripts/bootstrap_vectors.sh >/dev/null
        echo "${label}_PYTHON"
        timeout --foreground "$REHYDRATE_STEP_TIMEOUT_SECONDS" ./scripts/test_python.sh >/dev/null
        echo "${label}_TYPESCRIPT"
        timeout --foreground "$REHYDRATE_STEP_TIMEOUT_SECONDS" ./scripts/test_typescript.sh >/dev/null
        echo "${label}_KOTLIN"
        timeout --foreground "$REHYDRATE_STEP_TIMEOUT_SECONDS" ./scripts/test_kotlin.sh >/dev/null
        echo "${label}_TPKG"
        timeout --foreground "$REHYDRATE_STEP_TIMEOUT_SECONDS" ./scripts/build_sample_packages.sh >/dev/null
    )
}

mkdir -p "$VERIFY_DIR/source"
unzip -q "$SOURCE_ZIP" -d "$VERIFY_DIR/source"
SOURCE_ROOT="$(find "$VERIFY_DIR/source" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
run_rehydrated_suite "$SOURCE_ROOT" "SOURCE_ZIP"

git clone -q "$BUNDLE" "$VERIFY_DIR/bundle"
(
    cd "$VERIFY_DIR/bundle"
    git checkout -q "$COMMIT"
)
run_rehydrated_suite "$VERIFY_DIR/bundle" "GIT_BUNDLE"

printf '%s\n' 'SOURCE_ZIP_REHYDRATE_PASS' 'GIT_BUNDLE_REHYDRATE_PASS' >> "$TEST_LOG"
rm -rf "$VERIFY_DIR"
trap - EXIT

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

PYTHON_VERSION="$(python3 --version 2>&1)"
NODE_VERSION="$(node --version 2>&1)"
KOTLIN_VERSION="$(kotlinc -version 2>&1 | head -n 1)"
PYTEST_SUMMARY="$(grep -E '^[0-9]+ passed$' "$TEST_LOG" | tail -n 1)"
if [[ -z "$PYTEST_SUMMARY" ]]; then
    echo "Could not find normalized pytest summary in $TEST_LOG" >&2
    exit 1
fi

cat > "$DELIVERY_MANIFEST" <<EOF_MANIFEST
# A620 Gate 0 rc3 baseline.3 交付清单

- 候选状态：\`GATE_0_IMPLEMENTATION_CANDIDATE_NOT_APPROVED\`
- Git 分支：\`$BRANCH\`
- Git 提交：\`$COMMIT\`
- Git 标签：\`$TAG\`
- 日期：\`$DATE_TAG\`

## 自动测试

\`$PYTEST_SUMMARY / TYPESCRIPT_GATE0_TESTS_PASS / KOTLIN_GATE0_TESTS_PASS / SAMPLE_TPKG_BUILD_AND_VALIDATE_PASS / SOURCE_ZIP_REHYDRATE_PASS / GIT_BUNDLE_REHYDRATE_PASS\`

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

本交付不包含 Android APK、Cocos Creator 工程、真实 AIDL/Binder、Room、原生触摸门、两款游戏代表等级、正式素材或生产密钥。SQLite 与 A/B 槽均为参考实现，尚未替代候选平板上的进程杀死、真实闪存断电和文件系统验证。它不能用于患者任务，也不能据此宣称 Gate 0 已通过。
EOF_MANIFEST

python3 - "$COMPLETE_ZIP" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$COMPONENT_CHECKSUMS" "$DELIVERY_MANIFEST" "$TEST_LOG" "$ROOT/docs/TEST_REPORT_20260817.md" "$ROOT/docs/HARDENING_BASELINE3_20260817.md" <<'PY'
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
