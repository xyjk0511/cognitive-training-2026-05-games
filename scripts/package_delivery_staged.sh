#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
STAGE="${2:-}"
DATE_TAG="${DATE_TAG:-20260818}"
BASE="A620_GateAB_rc3_baseline7_${DATE_TAG}"
TAG="a620-trc-1.1-rc3-baseline.7"
BASE6="cbe5c2bbd52834c7f5531582c0f75e4f56f1b024"
STATE="$ROOT/build/delivery/$BASE"
SOURCE="$OUT_DIR/${BASE}_source.zip"
BUNDLE="$OUT_DIR/${BASE}_source.git.bundle"
ANDROID="$OUT_DIR/${BASE}_android_runtime_ingress_source.zip"
PATCH="$OUT_DIR/${BASE}_baseline6_to_baseline7.patch"
PACKAGES="$OUT_DIR/${BASE}_sample_training_packages.zip"
TESTLOG="$OUT_DIR/${BASE}_test_all.log"
SRCLOG="$OUT_DIR/${BASE}_source_rehydrate.log"
BUNDLELOG="$OUT_DIR/${BASE}_git_bundle_rehydrate.log"
PREFLIGHT="$OUT_DIR/${BASE}_android_sdk_preflight.log"
MANIFEST="$OUT_DIR/${BASE}_DELIVERY_MANIFEST.md"
FINAL="$OUT_DIR/${BASE}_FINAL_VERIFIED.txt"
COMPONENTS="$OUT_DIR/${BASE}_component_SHA256SUMS.txt"
ALLSUMS="$OUT_DIR/${BASE}_ALL_SHA256SUMS.txt"
COMPLETE="$OUT_DIR/${BASE}_complete_delivery.zip"
mkdir -p "$OUT_DIR" "$STATE"
sha256() { sha256sum "$1" | awk '{print $1}'; }
require_clean_tag() {
  [[ -z "$(cd "$ROOT" && git status --porcelain)" ]] || { echo DIRTY_WORKTREE >&2; exit 1; }
  [[ "$(cd "$ROOT" && git rev-parse "$TAG^{commit}")" == "$(cd "$ROOT" && git rev-parse HEAD)" ]] || { echo TAG_MISMATCH >&2; exit 1; }
}
make_package_zip() {
  python3 - "$ROOT" "$PACKAGES" <<'PY'
from pathlib import Path
import sys,zipfile
root=Path(sys.argv[1]); out=Path(sys.argv[2])
def zi(name):
 z=zipfile.ZipInfo(name,(1980,1,1,0,0,0)); z.compress_type=zipfile.ZIP_STORED; z.create_system=3; z.external_attr=0o100644<<16; return z
with zipfile.ZipFile(out,'w') as f:
 for p in (root/'build/packages/catch-light-gate0.tpkg',root/'build/packages/signal-station-gate0.tpkg'):
  f.writestr(zi(p.name),p.read_bytes())
PY
}
run_full() {
  local checkout="$1" log="$2"
  : > "$log"
  (cd "$checkout" && ./scripts/test_all.sh && ./scripts/build_sample_packages.sh) 2>&1 | tee "$log"
}
case "$STAGE" in
prepare)
  require_clean_tag
  run_full "$ROOT" "$TESTLOG"
  grep -q ALL_GATE0_AND_GATEAB_BASELINE7_TESTS_PASS "$TESTLOG"
  make_package_zip
  rm -f "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PREFLIGHT"
  (cd "$ROOT" && git archive --format=zip --prefix="$(basename "$ROOT")/" -o "$SOURCE" HEAD)
  (cd "$ROOT" && git bundle create "$BUNDLE" --all && git bundle verify "$BUNDLE" >/dev/null)
  (cd "$ROOT" && git diff --binary "$BASE6" HEAD > "$PATCH")
  (cd "$ROOT" && git archive --format=zip -o "$ANDROID" HEAD \
    gateab_runtime_shell/android \
    gateab_runtime_shell/normative/android_runtime_shell_profile.json \
    gateab_runtime_shell/tools/generate_runtime_shell_profiles.py \
    gateab_runtime_shell/kotlin/src/main/kotlin/a620/shell \
    kotlin/src/main/kotlin/a620 \
    docs/HARDENING_BASELINE7_20260818.md)
  set +e
  "$ROOT/gateab_runtime_shell/android/ci/android_sdk_preflight.sh" > "$PREFLIGHT" 2>&1
  rc=$?
  set -e
  echo "ANDROID_SDK_PREFLIGHT_EXIT=$rc" >> "$PREFLIGHT"
  case "$rc" in
    0) echo ANDROID_SDK_BUILD_AND_LINT_VERIFIED >> "$PREFLIGHT" ;;
    21|22|23|24) echo EXPECTED_ENVIRONMENT_LIMITATION_ANDROID_SDK_BUILD_NOT_CLAIMED >> "$PREFLIGHT" ;;
    *) echo UNEXPECTED_ANDROID_PREFLIGHT_FAILURE_$rc >&2; exit 1 ;;
  esac
  unzip -t "$SOURCE" >/dev/null
  unzip -t "$ANDROID" >/dev/null
  unzip -t "$PACKAGES" >/dev/null
  printf '%s\n' "$(git -C "$ROOT" rev-parse HEAD)" > "$STATE/commit"
  echo DELIVERY_PREPARE_PASS
  ;;
verify-source)
  [[ -f "$STATE/commit" && -f "$SOURCE" ]] || { echo PREPARE_REQUIRED >&2; exit 1; }
  tmp="$STATE/source-checkout"; rm -rf "$tmp"; mkdir -p "$tmp"
  unzip -q "$SOURCE" -d "$tmp"
  src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  run_full "$src" "$SRCLOG"
  grep -q ALL_GATE0_AND_GATEAB_BASELINE7_TESTS_PASS "$SRCLOG"
  echo SOURCE_ZIP_REHYDRATE_PASS >> "$SRCLOG"
  rm -rf "$tmp"
  echo SOURCE_ZIP_REHYDRATE_PASS
  ;;
verify-bundle)
  [[ -f "$STATE/commit" && -f "$BUNDLE" ]] || { echo PREPARE_REQUIRED >&2; exit 1; }
  tmp="$STATE/bundle-checkout"; rm -rf "$tmp"
  git clone -q "$BUNDLE" "$tmp"
  (cd "$tmp" && git checkout -q "$(cat "$STATE/commit")")
  run_full "$tmp" "$BUNDLELOG"
  grep -q ALL_GATE0_AND_GATEAB_BASELINE7_TESTS_PASS "$BUNDLELOG"
  echo GIT_BUNDLE_REHYDRATE_PASS >> "$BUNDLELOG"
  rm -rf "$tmp"
  echo GIT_BUNDLE_REHYDRATE_PASS
  ;;
assemble)
  for p in "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT"; do [[ -f "$p" ]] || { echo MISSING_$p >&2; exit 1; }; done
  grep -q SOURCE_ZIP_REHYDRATE_PASS "$SRCLOG"
  grep -q GIT_BUNDLE_REHYDRATE_PASS "$BUNDLELOG"
  commit="$(cat "$STATE/commit")"; branch="$(git -C "$ROOT" branch --show-current)"
  read -r files lines < <(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
r=Path(sys.argv[1]); skip={'.git','build','dist','node_modules','__pycache__','.pytest_cache'}
n=0; lines=0
for p in r.rglob('*'):
 if not p.is_file() or any(x in skip for x in p.relative_to(r).parts): continue
 if p.suffix in {'.pyc','.jar','.class','.tpkg','.zip','.bundle'}: continue
 try: t=p.read_text('utf-8')
 except Exception: continue
 n+=1; lines+=len(t.splitlines())
print(n,lines)
PY
  )
  python3 - "$MANIFEST" "$branch" "$commit" "$TAG" "$files" "$lines" <<'PY'
from pathlib import Path
import sys
out,branch,commit,tag,files,lines=sys.argv[1:]
Path(out).write_text(f'''# A620 Gate A/B rc3 baseline.7 交付清单

- 公共契约：`A620-TRC-1.1`
- 实现候选：`rc3-baseline.7`
- 状态：`GATE_AB_RUNTIME_INGRESS_CANDIDATE_NOT_DEVICE_APPROVED`
- Git 分支：`{branch}`
- Git 提交：`{commit}`
- Git 标签：`{tag}`
- 日期：`20260818`

## 本轮实现

严格 A620-JCS-1 报文入口；AIDL 声明与规范化报文身份交叉核对；大载荷 PFD 异步读取；跨异步读取的因果有序屏障；紧急/普通容量预留但不重排；仅 HEARTBEAT/STATE_SNAPSHOT 可在反压时丢弃；触摸边界显式 CANCEL_STREAM；双向回调使用同一入口策略；Android 工具链锁与 fail-closed 预检。

## 自动证据

- Python：75 + 28 + 14 + 35 = 152 项通过；
- TypeScript：Gate 0、baseline.5、baseline.6、baseline.7 通过；
- Kotlin/JVM：Gate 0、baseline.5、baseline.6、baseline.7 与 Android stub 通过；
- 两份样例训练包构建和验证通过；
- 源码 ZIP 与 Git bundle 各自独立全量还原通过。

## 规模

- 文本源码、规范、Schema、测试和文档：`{files}` 个文件；
- 总行数：`{lines}` 行（包含生成代码、测试与文档）。

## 限制

当前环境缺少 Gradle 9.5.0 和 Android SDK，所以未生成或宣称通过真实 APK、AGP AIDL 生成、Android lint 或候选设备测试。当前 Android 代码通过的是 Kotlin/JVM + Android/AIDL stub 编译和对抗测试。候选仍不能用于患者任务。
''',encoding='utf-8')
PY
  cat > "$FINAL" <<EOF2
A620_BASELINE7_FINAL_VERIFIED
contractVersion=A620-TRC-1.1
implementationCandidate=rc3-baseline.7
status=GATE_AB_RUNTIME_INGRESS_CANDIDATE_NOT_DEVICE_APPROVED
branch=$branch
commit=$commit
tag=$TAG
mainTestSuite=PASS
pythonTests=152
sourceZipRehydrate=PASS
gitBundleRehydrate=PASS
sampleTrainingPackages=PASS
androidSdkBuild=NOT_RUN_ENVIRONMENT_MISSING
wireSemanticChange=false
EOF2
  sha256sum "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$MANIFEST" "$FINAL" > "$COMPONENTS"
  python3 - "$COMPLETE" "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$COMPONENTS" "$MANIFEST" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$FINAL" "$ROOT/docs/HARDENING_BASELINE7_20260818.md" <<'PY'
from pathlib import Path
import sys,zipfile
out=Path(sys.argv[1]); paths=[Path(x) for x in sys.argv[2:]]
def zi(name,stored):
 z=zipfile.ZipInfo(name,(1980,1,1,0,0,0)); z.compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED; z.create_system=3; z.external_attr=0o100644<<16; return z
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as f:
 for p in paths:
  stored=p.suffix in {'.zip','.bundle'}
  f.writestr(zi(p.name,stored),p.read_bytes(),compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED,compresslevel=None if stored else 9)
PY
  sha256sum "$COMPLETE" "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$MANIFEST" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$FINAL" > "$ALLSUMS"
  unzip -t "$COMPLETE" >/dev/null
  echo DELIVERY_ASSEMBLE_PASS
  printf '%s\n' "$COMPLETE" "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$MANIFEST" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$FINAL" "$ALLSUMS"
  ;;
*) echo "Usage: $0 [out] {prepare|verify-source|verify-bundle|assemble}" >&2; exit 2 ;;
esac
