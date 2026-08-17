#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
STAGE="${2:-}"
DATE_TAG="${DATE_TAG:-20260817}"
BASENAME="A620_Gate0_rc3_baseline3_${DATE_TAG}"
EXPECTED_TAG="a620-trc-1.1-rc3-baseline.3"
STEP_TIMEOUT_SECONDS="${A620_REHYDRATE_STEP_TIMEOUT_SECONDS:-180}"
STATE_DIR="$ROOT/build/delivery/$BASENAME"
CONTEXT="$STATE_DIR/context.json"
SOURCE_MARKER="$STATE_DIR/source-verified.json"
BUNDLE_MARKER="$STATE_DIR/bundle-verified.json"
SOURCE_VERIFY_LOG="$STATE_DIR/source-verify.log"
BUNDLE_VERIFY_LOG="$STATE_DIR/bundle-verify.log"

SOURCE_ZIP="$OUT_DIR/${BASENAME}_source.zip"
BUNDLE="$OUT_DIR/${BASENAME}_source.git.bundle"
PACKAGE_ZIP="$OUT_DIR/${BASENAME}_sample_training_packages.zip"
COMPLETE_ZIP="$OUT_DIR/${BASENAME}_complete_delivery.zip"
COMPONENT_CHECKSUMS="$OUT_DIR/${BASENAME}_component_SHA256SUMS.txt"
ALL_CHECKSUMS="$OUT_DIR/${BASENAME}_ALL_SHA256SUMS.txt"
DELIVERY_MANIFEST="$OUT_DIR/${BASENAME}_DELIVERY_MANIFEST.md"
TEST_LOG="$OUT_DIR/${BASENAME}_test_all.log"
RAW_TEST_LOG="$STATE_DIR/test_all_raw.log"

mkdir -p "$OUT_DIR" "$STATE_DIR"

sha256_file() {
    python3 - "$1" <<'PY'
import hashlib,sys
from pathlib import Path
print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

read_context_field() {
    python3 - "$CONTEXT" "$1" <<'PY'
import json,sys
from pathlib import Path
value=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
print(value[sys.argv[2]])
PY
}

require_context() {
    [[ -f "$CONTEXT" ]] || { echo "Missing staged delivery context; run prepare first." >&2; exit 1; }
    local expected_commit
    expected_commit="$(read_context_field commit)"
    [[ "$(cd "$ROOT" && git rev-parse HEAD)" == "$expected_commit" ]] || {
        echo "Repository HEAD changed after prepare; rerun prepare." >&2; exit 1;
    }
}

run_rehydrated_suite() {
    local checkout_root="$1"
    local label="$2"
    local log="$3"
    : > "$log"
    (
        cd "$checkout_root"
        for item in \
          "BOOTSTRAP:./scripts/bootstrap_vectors.sh" \
          "PYTHON:./scripts/test_python.sh" \
          "TYPESCRIPT:./scripts/test_typescript.sh" \
          "KOTLIN:./scripts/test_kotlin.sh" \
          "TPKG:./scripts/build_sample_packages.sh"; do
            name="${item%%:*}"
            command="${item#*:}"
            echo "${label}_${name}_START" >> "$log"
            timeout --foreground "$STEP_TIMEOUT_SECONDS" bash -lc "$command" >/dev/null
            echo "${label}_${name}_PASS" >> "$log"
        done
    )
}

case "$STAGE" in
prepare)
    rm -rf "$STATE_DIR"
    mkdir -p "$STATE_DIR"
    "$ROOT/scripts/bootstrap_vectors.sh"
    set -o pipefail
    "$ROOT/scripts/test_all.sh" 2>&1 | tee "$RAW_TEST_LOG"
    python3 - "$RAW_TEST_LOG" "$TEST_LOG" "$ROOT" <<'PY'
from pathlib import Path
import re,sys
raw=Path(sys.argv[1]).read_text(encoding='utf-8')
root=str(Path(sys.argv[3]).resolve())
normalized=re.sub(r"(\d+ passed)(?:, \d+ warning(?:s)?)? in \d+(?:\.\d+)?s",r"\1",raw)
normalized=normalized.replace(root,"<REPO>")
Path(sys.argv[2]).write_text(normalized,encoding='utf-8')
PY
    cp "$TEST_LOG" "$ROOT/build/reports/test_all_${DATE_TAG}.txt"

    if [[ -n "$(cd "$ROOT" && git status --porcelain)" ]]; then
        echo "Refusing to prepare delivery from a dirty working tree." >&2
        (cd "$ROOT" && git status --short) >&2
        exit 1
    fi
    COMMIT="$(cd "$ROOT" && git rev-parse HEAD)"
    BRANCH="$(cd "$ROOT" && git branch --show-current)"
    TAG_COMMIT="$(cd "$ROOT" && git rev-list -n 1 "$EXPECTED_TAG" 2>/dev/null || true)"
    [[ "$TAG_COMMIT" == "$COMMIT" ]] || { echo "Expected tag $EXPECTED_TAG does not point to $COMMIT." >&2; exit 1; }

    rm -f "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$COMPLETE_ZIP" "$COMPONENT_CHECKSUMS" "$ALL_CHECKSUMS" "$DELIVERY_MANIFEST"
    python3 - "$ROOT" "$SOURCE_ZIP" <<'PY'
from __future__ import annotations
import sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]).resolve(); out=Path(sys.argv[2]).resolve(); prefix=root.name
excluded_dirs={'.git','build','node_modules','dist','__pycache__','.pytest_cache'}
excluded_suffixes={'.pyc','.jar','.class','.tpkg','.tmp'}
def info(name,executable):
    i=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0)); i.compress_type=zipfile.ZIP_DEFLATED
    i.create_system=3; i.external_attr=((0o100755 if executable else 0o100644)<<16); i.flag_bits|=0x800; return i
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as zf:
    for path in sorted(root.rglob('*')):
        if not path.is_file(): continue
        rel=path.relative_to(root)
        if any(part in excluded_dirs for part in rel.parts) or path.suffix in excluded_suffixes: continue
        zf.writestr(info((Path(prefix)/rel).as_posix(),bool(path.stat().st_mode&0o111)),path.read_bytes(),compresslevel=9)
PY
    (cd "$ROOT" && git bundle create "$BUNDLE" --all && git bundle verify "$BUNDLE" >/dev/null)
    python3 - "$CONTEXT" "$COMMIT" "$BRANCH" "$EXPECTED_TAG" "$(sha256_file "$SOURCE_ZIP")" "$(sha256_file "$BUNDLE")" "$(sha256_file "$TEST_LOG")" <<'PY'
import json,sys
from pathlib import Path
out=Path(sys.argv[1]); data={
 'contextVersion':'A620-DELIVERY-STAGE-1','commit':sys.argv[2],'branch':sys.argv[3],'tag':sys.argv[4],
 'sourceZipSha256':sys.argv[5],'gitBundleSha256':sys.argv[6],'testLogSha256':sys.argv[7],
}
out.write_text(json.dumps(data,sort_keys=True,separators=(',',':'))+'\n',encoding='utf-8')
PY
    unzip -t "$SOURCE_ZIP" >/dev/null
    echo "DELIVERY_PREPARE_PASS"
    ;;
verify-source)
    require_context
    [[ "$(sha256_file "$SOURCE_ZIP")" == "$(read_context_field sourceZipSha256)" ]] || { echo "Source ZIP hash changed." >&2; exit 1; }
    VERIFY_DIR="$(mktemp -d)"; trap 'rm -rf "$VERIFY_DIR"' EXIT
    unzip -q "$SOURCE_ZIP" -d "$VERIFY_DIR"
    SOURCE_ROOT="$(find "$VERIFY_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    run_rehydrated_suite "$SOURCE_ROOT" "SOURCE_ZIP" "$SOURCE_VERIFY_LOG"
    python3 - "$SOURCE_MARKER" "$(read_context_field commit)" "$(read_context_field sourceZipSha256)" "$(sha256_file "$SOURCE_VERIFY_LOG")" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'commit':sys.argv[2],'artifactSha256':sys.argv[3],'verifyLogSha256':sys.argv[4]},sort_keys=True,separators=(',',':'))+'\n',encoding='utf-8')
PY
    echo "SOURCE_ZIP_REHYDRATE_PASS"
    ;;
verify-bundle)
    require_context
    [[ "$(sha256_file "$BUNDLE")" == "$(read_context_field gitBundleSha256)" ]] || { echo "Git bundle hash changed." >&2; exit 1; }
    git bundle verify "$BUNDLE" >/dev/null
    VERIFY_DIR="$(mktemp -d)"; trap 'rm -rf "$VERIFY_DIR"' EXIT
    git clone -q "$BUNDLE" "$VERIFY_DIR/repo"
    (cd "$VERIFY_DIR/repo" && git checkout -q "$(read_context_field commit)")
    run_rehydrated_suite "$VERIFY_DIR/repo" "GIT_BUNDLE" "$BUNDLE_VERIFY_LOG"
    python3 - "$BUNDLE_MARKER" "$(read_context_field commit)" "$(read_context_field gitBundleSha256)" "$(sha256_file "$BUNDLE_VERIFY_LOG")" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'commit':sys.argv[2],'artifactSha256':sys.argv[3],'verifyLogSha256':sys.argv[4]},sort_keys=True,separators=(',',':'))+'\n',encoding='utf-8')
PY
    echo "GIT_BUNDLE_REHYDRATE_PASS"
    ;;
assemble)
    require_context
    [[ -f "$SOURCE_MARKER" && -f "$BUNDLE_MARKER" ]] || { echo "Both rehydration stages must pass before assemble." >&2; exit 1; }
    python3 - "$CONTEXT" "$SOURCE_MARKER" sourceZipSha256 "$SOURCE_ZIP" <<'PY'
import hashlib,json,sys
from pathlib import Path
ctx=json.loads(Path(sys.argv[1]).read_text()); marker=json.loads(Path(sys.argv[2]).read_text()); actual=hashlib.sha256(Path(sys.argv[4]).read_bytes()).hexdigest()
assert marker['commit']==ctx['commit'] and marker['artifactSha256']==ctx[sys.argv[3]]==actual
PY
    python3 - "$CONTEXT" "$BUNDLE_MARKER" gitBundleSha256 "$BUNDLE" <<'PY'
import hashlib,json,sys
from pathlib import Path
ctx=json.loads(Path(sys.argv[1]).read_text()); marker=json.loads(Path(sys.argv[2]).read_text()); actual=hashlib.sha256(Path(sys.argv[4]).read_bytes()).hexdigest()
assert marker['commit']==ctx['commit'] and marker['artifactSha256']==ctx[sys.argv[3]]==actual
PY
    grep -qx 'SOURCE_ZIP_REHYDRATE_PASS' "$TEST_LOG" || printf '%s\n' 'SOURCE_ZIP_REHYDRATE_PASS' >> "$TEST_LOG"
    grep -qx 'GIT_BUNDLE_REHYDRATE_PASS' "$TEST_LOG" || printf '%s\n' 'GIT_BUNDLE_REHYDRATE_PASS' >> "$TEST_LOG"
    "$ROOT/scripts/build_sample_packages.sh" >/dev/null

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
    COMMIT="$(read_context_field commit)"; BRANCH="$(read_context_field branch)"; TAG="$(read_context_field tag)"
    PYTHON_VERSION="$(python3 --version 2>&1)"; NODE_VERSION="$(node --version 2>&1)"; KOTLIN_VERSION="$(kotlinc -version 2>&1 | head -n 1)"
    PYTEST_SUMMARY="$(grep -E '^[0-9]+ passed$' "$TEST_LOG" | tail -n 1)"
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

- \`$(basename "$SOURCE_ZIP")\`：完整源码、规范及可重建脚本；
- \`$(basename "$BUNDLE")\`：可离线还原全部 Git 引用；
- \`$(basename "$PACKAGE_ZIP")\`：两份空插件样例训练包；
- \`$(basename "$TEST_LOG")\`：规范化主测试日志；
- \`$(basename "$SOURCE_VERIFY_LOG")\`、\`$(basename "$BUNDLE_VERIFY_LOG")\`：双路径重建分步证据；
- \`$(basename "$COMPONENT_CHECKSUMS")\`：组件 SHA-256。

## 明确限制

本交付不包含 Android APK、Cocos Creator 工程、真实 AIDL/Binder、Room、原生触摸门、两款游戏代表等级、正式素材或生产密钥。SQLite 与 A/B 槽均为参考实现，尚未替代候选平板上的进程杀死、真实闪存断电和文件系统验证。它不能用于患者任务，也不能据此宣称 Gate 0 已通过。
EOF_MANIFEST
    python3 - "$COMPLETE_ZIP" "$SOURCE_ZIP" "$BUNDLE" "$PACKAGE_ZIP" "$COMPONENT_CHECKSUMS" "$DELIVERY_MANIFEST" "$TEST_LOG" "$SOURCE_VERIFY_LOG" "$BUNDLE_VERIFY_LOG" "$ROOT/docs/TEST_REPORT_20260817.md" "$ROOT/docs/HARDENING_BASELINE3_20260817.md" <<'PY'
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
*)
    echo "Usage: $0 [out_dir] {prepare|verify-source|verify-bundle|assemble}" >&2
    exit 2
    ;;
esac
