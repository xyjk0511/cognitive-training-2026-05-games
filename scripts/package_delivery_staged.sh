#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
STAGE="${2:-}"
DATE_TAG="${DATE_TAG:-20260817}"
BASENAME="A620_Gate0_rc3_baseline4_${DATE_TAG}"
EXPECTED_TAG="a620-trc-1.1-rc3-baseline.4"
STEP_TIMEOUT_SECONDS="${A620_REHYDRATE_STEP_TIMEOUT_SECONDS:-180}"
STATE_DIR="$ROOT/build/delivery/$BASENAME"
CONTEXT="$STATE_DIR/context.json"
SOURCE_CHECKOUT="$STATE_DIR/source-checkout"
BUNDLE_CHECKOUT="$STATE_DIR/bundle-checkout"
SOURCE_CORE_MARKER="$STATE_DIR/source-core.json"
SOURCE_KOTLIN_MARKER="$STATE_DIR/source-kotlin.json"
SOURCE_MARKER="$STATE_DIR/source-verified.json"
BUNDLE_CORE_MARKER="$STATE_DIR/bundle-core.json"
BUNDLE_KOTLIN_MARKER="$STATE_DIR/bundle-kotlin.json"
BUNDLE_MARKER="$STATE_DIR/bundle-verified.json"
CORE_TESTS_MARKER="$STATE_DIR/core-tests.json"
TESTS_MARKER="$STATE_DIR/tests.json"
PACKAGES_MARKER="$STATE_DIR/packages.json"
SOURCE_VERIFY_LOG="$STATE_DIR/source-verify.log"
BUNDLE_VERIFY_LOG="$STATE_DIR/bundle-verify.log"
RAW_TEST_LOG="$STATE_DIR/test_all_raw.log"

SOURCE_ZIP="$OUT_DIR/${BASENAME}_source.zip"
BUNDLE="$OUT_DIR/${BASENAME}_source.git.bundle"
PACKAGE_ZIP="$OUT_DIR/${BASENAME}_sample_training_packages.zip"
COMPLETE_ZIP="$OUT_DIR/${BASENAME}_complete_delivery.zip"
COMPONENT_CHECKSUMS="$OUT_DIR/${BASENAME}_component_SHA256SUMS.txt"
ALL_CHECKSUMS="$OUT_DIR/${BASENAME}_ALL_SHA256SUMS.txt"
DELIVERY_MANIFEST="$OUT_DIR/${BASENAME}_DELIVERY_MANIFEST.md"
TEST_LOG="$OUT_DIR/${BASENAME}_test_all.log"

mkdir -p "$OUT_DIR" "$STATE_DIR"

sha256_file() {
    python3 - "$1" <<'PY'
import hashlib,sys
from pathlib import Path
print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

write_marker() {
    local path="$1"; shift
    python3 - "$path" "$@" <<'PY'
import json,sys
from pathlib import Path
pairs=sys.argv[2:]
if len(pairs)%2: raise SystemExit('marker arguments must be key/value pairs')
value={pairs[i]:pairs[i+1] for i in range(0,len(pairs),2)}
Path(sys.argv[1]).write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='utf-8')
PY
}

read_json_field() {
    python3 - "$1" "$2" <<'PY'
import json,sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))[sys.argv[2]])
PY
}

require_file() {
    [[ -f "$1" ]] || { echo "Missing staged prerequisite: $1" >&2; exit 1; }
}

require_context() {
    require_file "$CONTEXT"
    local expected_commit
    expected_commit="$(read_json_field "$CONTEXT" commit)"
    [[ "$(cd "$ROOT" && git rev-parse HEAD)" == "$expected_commit" ]] || {
        echo "Repository HEAD changed after prepare-artifacts; restart staged delivery." >&2; exit 1;
    }
}

run_logged() {
    local log="$1"; local label="$2"; shift 2
    echo "${label}_START" >> "$log"
    timeout --foreground "$STEP_TIMEOUT_SECONDS" "$@" 2>&1 | tee -a "$log"
    echo "${label}_PASS" >> "$log"
}

run_quiet_logged() {
    local checkout="$1"; local log="$2"; local label="$3"; shift 3
    echo "${label}_START" >> "$log"
    (cd "$checkout" && timeout --foreground "$STEP_TIMEOUT_SECONDS" "$@" >/dev/null)
    echo "${label}_PASS" >> "$log"
}

normalise_main_log() {
    python3 - "$RAW_TEST_LOG" "$TEST_LOG" "$ROOT" <<'PY'
from pathlib import Path
import re,sys
raw=Path(sys.argv[1]).read_text(encoding='utf-8')
root=str(Path(sys.argv[3]).resolve())
normalized=re.sub(r"(\d+ passed)(?:, \d+ warning(?:s)?)? in \d+(?:\.\d+)?s",r"\1",raw)
normalized=normalized.replace(root,"<REPO>")
Path(sys.argv[2]).write_text(normalized,encoding='utf-8')
PY
}

case "$STAGE" in
prepare-core)
    rm -rf "$STATE_DIR"; mkdir -p "$STATE_DIR"; : > "$RAW_TEST_LOG"
    run_logged "$RAW_TEST_LOG" BOOTSTRAP "$ROOT/scripts/bootstrap_vectors.sh"
    run_logged "$RAW_TEST_LOG" PYTHON "$ROOT/scripts/test_python.sh"
    run_logged "$RAW_TEST_LOG" TYPESCRIPT "$ROOT/scripts/test_typescript.sh"
    write_marker "$CORE_TESTS_MARKER" commit "$(cd "$ROOT" && git rev-parse HEAD)" rawLogSha256 "$(sha256_file "$RAW_TEST_LOG")"
    echo "DELIVERY_PREPARE_CORE_PASS"
    ;;
prepare-kotlin)
    require_file "$CORE_TESTS_MARKER"
    [[ "$(read_json_field "$CORE_TESTS_MARKER" commit)" == "$(cd "$ROOT" && git rev-parse HEAD)" ]] || { echo "HEAD changed after prepare-core." >&2; exit 1; }
    run_logged "$RAW_TEST_LOG" KOTLIN "$ROOT/scripts/test_kotlin.sh"
    write_marker "$TESTS_MARKER" commit "$(cd "$ROOT" && git rev-parse HEAD)" rawLogSha256 "$(sha256_file "$RAW_TEST_LOG")"
    echo "DELIVERY_PREPARE_KOTLIN_PASS"
    ;;
prepare-packages)
    require_file "$TESTS_MARKER"
    [[ "$(read_json_field "$TESTS_MARKER" commit)" == "$(cd "$ROOT" && git rev-parse HEAD)" ]] || { echo "HEAD changed after prepare-tests." >&2; exit 1; }
    run_logged "$RAW_TEST_LOG" TPKG "$ROOT/scripts/build_sample_packages.sh"
    echo "ALL_GATE0_IMPLEMENTATION_TESTS_PASS" >> "$RAW_TEST_LOG"
    normalise_main_log
    mkdir -p "$ROOT/build/reports"; cp "$TEST_LOG" "$ROOT/build/reports/test_all_${DATE_TAG}.txt"
    write_marker "$PACKAGES_MARKER" commit "$(cd "$ROOT" && git rev-parse HEAD)" testLogSha256 "$(sha256_file "$TEST_LOG")" catchLightSha256 "$(sha256_file "$ROOT/build/packages/catch-light-gate0.tpkg")" signalStationSha256 "$(sha256_file "$ROOT/build/packages/signal-station-gate0.tpkg")"
    echo "DELIVERY_PREPARE_PACKAGES_PASS"
    ;;
prepare-artifacts)
    require_file "$TESTS_MARKER"; require_file "$PACKAGES_MARKER"
    if [[ -n "$(cd "$ROOT" && git status --porcelain)" ]]; then
        echo "Refusing to prepare delivery from a dirty working tree." >&2; (cd "$ROOT" && git status --short) >&2; exit 1
    fi
    COMMIT="$(cd "$ROOT" && git rev-parse HEAD)"; BRANCH="$(cd "$ROOT" && git branch --show-current)"
    [[ "$(read_json_field "$PACKAGES_MARKER" commit)" == "$COMMIT" ]] || { echo "HEAD changed after package tests." >&2; exit 1; }
    TAG_COMMIT="$(cd "$ROOT" && git rev-list -n 1 "$EXPECTED_TAG" 2>/dev/null || true)"
    [[ "$TAG_COMMIT" == "$COMMIT" ]] || { echo "Expected tag $EXPECTED_TAG does not point to $COMMIT." >&2; exit 1; }
    rm -f "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$COMPLETE_ZIP" "$COMPONENT_CHECKSUMS" "$ALL_CHECKSUMS" "$DELIVERY_MANIFEST"
    python3 - "$ROOT" "$SOURCE_ZIP" <<'PY'
from __future__ import annotations
import sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]).resolve(); out=Path(sys.argv[2]).resolve(); prefix=root.name
excluded_dirs={'.git','build','node_modules','dist','__pycache__','.pytest_cache'}; excluded_suffixes={'.pyc','.jar','.class','.tpkg','.tmp'}
def info(name,executable):
 i=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0)); i.compress_type=zipfile.ZIP_DEFLATED; i.create_system=3; i.external_attr=((0o100755 if executable else 0o100644)<<16); i.flag_bits|=0x800; return i
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as zf:
 for path in sorted(root.rglob('*')):
  if not path.is_file(): continue
  rel=path.relative_to(root)
  if any(part in excluded_dirs for part in rel.parts) or path.suffix in excluded_suffixes: continue
  zf.writestr(info((Path(prefix)/rel).as_posix(),bool(path.stat().st_mode&0o111)),path.read_bytes(),compresslevel=9)
PY
    (cd "$ROOT" && git bundle create "$BUNDLE" --all && git bundle verify "$BUNDLE" >/dev/null)
    write_marker "$CONTEXT" contextVersion A620-DELIVERY-STAGE-1 commit "$COMMIT" branch "$BRANCH" tag "$EXPECTED_TAG" sourceZipSha256 "$(sha256_file "$SOURCE_ZIP")" gitBundleSha256 "$(sha256_file "$BUNDLE")" testLogSha256 "$(sha256_file "$TEST_LOG")" catchLightSha256 "$(sha256_file "$ROOT/build/packages/catch-light-gate0.tpkg")" signalStationSha256 "$(sha256_file "$ROOT/build/packages/signal-station-gate0.tpkg")"
    unzip -t "$SOURCE_ZIP" >/dev/null
    echo "DELIVERY_PREPARE_ARTIFACTS_PASS"
    ;;
verify-source-core)
    require_context
    [[ "$(sha256_file "$SOURCE_ZIP")" == "$(read_json_field "$CONTEXT" sourceZipSha256)" ]] || { echo "Source ZIP hash changed." >&2; exit 1; }
    rm -rf "$SOURCE_CHECKOUT"; mkdir -p "$SOURCE_CHECKOUT"
    unzip -q "$SOURCE_ZIP" -d "$SOURCE_CHECKOUT"
    SOURCE_ROOT="$(find "$SOURCE_CHECKOUT" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    : > "$SOURCE_VERIFY_LOG"
    run_quiet_logged "$SOURCE_ROOT" "$SOURCE_VERIFY_LOG" SOURCE_ZIP_BOOTSTRAP ./scripts/bootstrap_vectors.sh
    run_quiet_logged "$SOURCE_ROOT" "$SOURCE_VERIFY_LOG" SOURCE_ZIP_PYTHON ./scripts/test_python.sh
    run_quiet_logged "$SOURCE_ROOT" "$SOURCE_VERIFY_LOG" SOURCE_ZIP_TYPESCRIPT ./scripts/test_typescript.sh
    write_marker "$SOURCE_CORE_MARKER" commit "$(read_json_field "$CONTEXT" commit)" artifactSha256 "$(read_json_field "$CONTEXT" sourceZipSha256)" checkout "$SOURCE_ROOT"
    echo "SOURCE_ZIP_CORE_REHYDRATE_PASS"
    ;;
verify-source-kotlin)
    require_context; require_file "$SOURCE_CORE_MARKER"
    SOURCE_ROOT="$(read_json_field "$SOURCE_CORE_MARKER" checkout)"; [[ -d "$SOURCE_ROOT" ]] || { echo "Source checkout missing." >&2; exit 1; }
    run_quiet_logged "$SOURCE_ROOT" "$SOURCE_VERIFY_LOG" SOURCE_ZIP_KOTLIN ./scripts/test_kotlin.sh
    write_marker "$SOURCE_KOTLIN_MARKER" commit "$(read_json_field "$CONTEXT" commit)" artifactSha256 "$(read_json_field "$CONTEXT" sourceZipSha256)"
    echo "SOURCE_ZIP_KOTLIN_REHYDRATE_PASS"
    ;;
verify-source-tpkg)
    require_context; require_file "$SOURCE_CORE_MARKER"; require_file "$SOURCE_KOTLIN_MARKER"
    SOURCE_ROOT="$(read_json_field "$SOURCE_CORE_MARKER" checkout)"; [[ -d "$SOURCE_ROOT" ]] || { echo "Source checkout missing." >&2; exit 1; }
    run_quiet_logged "$SOURCE_ROOT" "$SOURCE_VERIFY_LOG" SOURCE_ZIP_TPKG ./scripts/build_sample_packages.sh
    write_marker "$SOURCE_MARKER" commit "$(read_json_field "$CONTEXT" commit)" artifactSha256 "$(read_json_field "$CONTEXT" sourceZipSha256)" verifyLogSha256 "$(sha256_file "$SOURCE_VERIFY_LOG")"
    rm -rf "$SOURCE_CHECKOUT"
    echo "SOURCE_ZIP_REHYDRATE_PASS"
    ;;
verify-bundle-core)
    require_context
    [[ "$(sha256_file "$BUNDLE")" == "$(read_json_field "$CONTEXT" gitBundleSha256)" ]] || { echo "Git bundle hash changed." >&2; exit 1; }
    git bundle verify "$BUNDLE" >/dev/null
    rm -rf "$BUNDLE_CHECKOUT"; git clone -q "$BUNDLE" "$BUNDLE_CHECKOUT"; (cd "$BUNDLE_CHECKOUT" && git checkout -q "$(read_json_field "$CONTEXT" commit)")
    : > "$BUNDLE_VERIFY_LOG"
    run_quiet_logged "$BUNDLE_CHECKOUT" "$BUNDLE_VERIFY_LOG" GIT_BUNDLE_BOOTSTRAP ./scripts/bootstrap_vectors.sh
    run_quiet_logged "$BUNDLE_CHECKOUT" "$BUNDLE_VERIFY_LOG" GIT_BUNDLE_PYTHON ./scripts/test_python.sh
    run_quiet_logged "$BUNDLE_CHECKOUT" "$BUNDLE_VERIFY_LOG" GIT_BUNDLE_TYPESCRIPT ./scripts/test_typescript.sh
    write_marker "$BUNDLE_CORE_MARKER" commit "$(read_json_field "$CONTEXT" commit)" artifactSha256 "$(read_json_field "$CONTEXT" gitBundleSha256)" checkout "$BUNDLE_CHECKOUT"
    echo "GIT_BUNDLE_CORE_REHYDRATE_PASS"
    ;;
verify-bundle-kotlin)
    require_context; require_file "$BUNDLE_CORE_MARKER"; [[ -d "$BUNDLE_CHECKOUT" ]] || { echo "Bundle checkout missing." >&2; exit 1; }
    run_quiet_logged "$BUNDLE_CHECKOUT" "$BUNDLE_VERIFY_LOG" GIT_BUNDLE_KOTLIN ./scripts/test_kotlin.sh
    write_marker "$BUNDLE_KOTLIN_MARKER" commit "$(read_json_field "$CONTEXT" commit)" artifactSha256 "$(read_json_field "$CONTEXT" gitBundleSha256)"
    echo "GIT_BUNDLE_KOTLIN_REHYDRATE_PASS"
    ;;
verify-bundle-tpkg)
    require_context; require_file "$BUNDLE_CORE_MARKER"; require_file "$BUNDLE_KOTLIN_MARKER"; [[ -d "$BUNDLE_CHECKOUT" ]] || { echo "Bundle checkout missing." >&2; exit 1; }
    run_quiet_logged "$BUNDLE_CHECKOUT" "$BUNDLE_VERIFY_LOG" GIT_BUNDLE_TPKG ./scripts/build_sample_packages.sh
    write_marker "$BUNDLE_MARKER" commit "$(read_json_field "$CONTEXT" commit)" artifactSha256 "$(read_json_field "$CONTEXT" gitBundleSha256)" verifyLogSha256 "$(sha256_file "$BUNDLE_VERIFY_LOG")"
    rm -rf "$BUNDLE_CHECKOUT"
    echo "GIT_BUNDLE_REHYDRATE_PASS"
    ;;
assemble)
    require_context; require_file "$SOURCE_MARKER"; require_file "$BUNDLE_MARKER"
    [[ "$(sha256_file "$SOURCE_ZIP")" == "$(read_json_field "$CONTEXT" sourceZipSha256)" ]] || { echo "Source ZIP changed after verification." >&2; exit 1; }
    [[ "$(sha256_file "$BUNDLE")" == "$(read_json_field "$CONTEXT" gitBundleSha256)" ]] || { echo "Git bundle changed after verification." >&2; exit 1; }
    [[ "$(sha256_file "$TEST_LOG")" == "$(read_json_field "$CONTEXT" testLogSha256)" ]] || { echo "Main test log changed after prepare." >&2; exit 1; }
    [[ "$(sha256_file "$ROOT/build/packages/catch-light-gate0.tpkg")" == "$(read_json_field "$CONTEXT" catchLightSha256)" ]] || { echo "Catch Light sample changed." >&2; exit 1; }
    [[ "$(sha256_file "$ROOT/build/packages/signal-station-gate0.tpkg")" == "$(read_json_field "$CONTEXT" signalStationSha256)" ]] || { echo "Signal Station sample changed." >&2; exit 1; }
    grep -qx 'SOURCE_ZIP_REHYDRATE_PASS' "$TEST_LOG" || printf '%s\n' 'SOURCE_ZIP_REHYDRATE_PASS' >> "$TEST_LOG"
    grep -qx 'GIT_BUNDLE_REHYDRATE_PASS' "$TEST_LOG" || printf '%s\n' 'GIT_BUNDLE_REHYDRATE_PASS' >> "$TEST_LOG"
    python3 - "$ROOT" "$PACKAGE_ZIP" <<'PY'
import sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]).resolve(); out=Path(sys.argv[2]).resolve()
def info(name):
 i=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0)); i.compress_type=zipfile.ZIP_STORED; i.create_system=3; i.external_attr=0o100644<<16; i.flag_bits|=0x800; return i
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED) as zf:
 for p in [root/'build/packages/catch-light-gate0.tpkg',root/'build/packages/signal-station-gate0.tpkg']:
  zf.writestr(info(p.name),p.read_bytes())
PY
    python3 - "$COMPONENT_CHECKSUMS" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$TEST_LOG" "$SOURCE_VERIFY_LOG" "$BUNDLE_VERIFY_LOG" <<'PY'
import hashlib,sys
from pathlib import Path
out=Path(sys.argv[1]); paths=[Path(x) for x in sys.argv[2:]]
out.write_text(''.join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in paths),encoding='utf-8')
PY
    COMMIT="$(read_json_field "$CONTEXT" commit)"; BRANCH="$(read_json_field "$CONTEXT" branch)"; TAG="$(read_json_field "$CONTEXT" tag)"
    PYTHON_VERSION="$(python3 --version 2>&1)"; NODE_VERSION="$(node --version 2>&1)"; KOTLIN_VERSION="$(kotlinc -version 2>&1 | head -n 1)"; PYTEST_SUMMARY="$(grep -E '^[0-9]+ passed$' "$TEST_LOG" | tail -n 1)"
    read -r SOURCE_FILE_COUNT SOURCE_LINE_COUNT < <(python3 - "$ROOT" <<'PY_COUNT'
from pathlib import Path
import sys
root=Path(sys.argv[1])
excluded={'.git','build','node_modules','dist','__pycache__','.pytest_cache'}
files=[]
lines=0
for path in root.rglob('*'):
    if not path.is_file() or any(part in excluded for part in path.relative_to(root).parts):
        continue
    if path.suffix in {'.pyc','.jar','.class','.tpkg','.tmp','.zip','.bundle'}:
        continue
    try:
        text=path.read_text(encoding='utf-8')
    except (UnicodeDecodeError,OSError):
        continue
    files.append(path)
    lines += len(text.splitlines())
print(len(files), lines)
PY_COUNT
    )
    cat > "$DELIVERY_MANIFEST" <<EOF_MANIFEST
# A620 Gate 0 rc3 baseline.4 交付清单

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

## 规模

- 文本源码、规范、Schema、测试向量和文档：\`$SOURCE_FILE_COUNT\` 个文件；
- 总行数：\`$SOURCE_LINE_COUNT\` 行（包含生成表、Schema、测试向量和文档）。

## 组件

- \`$(basename "$SOURCE_ZIP")\`：完整源码、规范及可重建脚本；
- \`$(basename "$BUNDLE")\`：可离线还原全部 Git 引用；
- \`$(basename "$PACKAGE_ZIP")\`：两份空插件样例训练包；
- \`$(basename "$TEST_LOG")\`：规范化主测试日志；
- \`$(basename "$SOURCE_VERIFY_LOG")\`、\`$(basename "$BUNDLE_VERIFY_LOG")\`：双路径重建分步证据；
- \`$(basename "$COMPONENT_CHECKSUMS")\`：组件 SHA-256。

## 明确限制

本交付不包含 Android APK、Cocos Creator 工程、真实 AIDL/Binder、Room、原生触摸门、两款游戏代表等级、正式素材或生产密钥。SQLite outbox/journal、看门狗与 A/B 槽均为参考实现，尚未替代候选平板上的进程杀死、真实 Binder 丢包、真实闪存断电和文件系统验证。它不能用于患者任务，也不能据此宣称 Gate 0 已通过。
EOF_MANIFEST
    python3 - "$COMPLETE_ZIP" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$COMPONENT_CHECKSUMS" "$DELIVERY_MANIFEST" "$TEST_LOG" "$SOURCE_VERIFY_LOG" "$BUNDLE_VERIFY_LOG" "$ROOT/docs/TEST_REPORT_20260817.md" "$ROOT/docs/HARDENING_BASELINE4_20260817.md" <<'PY'
import sys,zipfile
from pathlib import Path
out=Path(sys.argv[1]); inputs=[Path(x) for x in sys.argv[2:]]
def info(name,comp):
 i=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0)); i.compress_type=comp; i.create_system=3; i.external_attr=0o100644<<16; i.flag_bits|=0x800; return i
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as zf:
 for p in inputs:
  comp=zipfile.ZIP_STORED if p.suffix in {'.zip','.bundle'} else zipfile.ZIP_DEFLATED
  zf.writestr(info(p.name,comp),p.read_bytes(),compresslevel=9 if comp==zipfile.ZIP_DEFLATED else None)
PY
    python3 - "$ALL_CHECKSUMS" "$COMPLETE_ZIP" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$DELIVERY_MANIFEST" "$TEST_LOG" "$SOURCE_VERIFY_LOG" "$BUNDLE_VERIFY_LOG" <<'PY'
import hashlib,sys
from pathlib import Path
out=Path(sys.argv[1]); paths=[Path(x) for x in sys.argv[2:]]
out.write_text(''.join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in paths),encoding='utf-8')
PY
    unzip -t "$SOURCE_ZIP" >/dev/null; unzip -t "$PACKAGE_ZIP" >/dev/null; unzip -t "$COMPLETE_ZIP" >/dev/null
    printf '%s\n' "$COMPLETE_ZIP" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$DELIVERY_MANIFEST" "$ALL_CHECKSUMS"
    ;;
*) echo "Usage: $0 [out_dir] {prepare-core|prepare-kotlin|prepare-packages|prepare-artifacts|verify-source-core|verify-source-kotlin|verify-source-tpkg|verify-bundle-core|verify-bundle-kotlin|verify-bundle-tpkg|assemble}" >&2; exit 2 ;;
esac
