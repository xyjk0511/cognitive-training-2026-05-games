#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-/mnt/data}"
STAGE="${2:-}"
DATE_TAG="${DATE_TAG:-20260818}"
BASE="A620_GateAB_rc3_baseline8_${DATE_TAG}"
TAG="a620-trc-1.1-rc3-baseline.8"
BASE7="e3fb6f5f5a8147c673b8f58012ef7625532642c7"
STATE="$ROOT/build/delivery/$BASE"
SOURCE="$OUT_DIR/${BASE}_source.zip"
BUNDLE="$OUT_DIR/${BASE}_source.git.bundle"
ANDROID="$OUT_DIR/${BASE}_android_authenticated_durable_controller_source.zip"
PATCH="$OUT_DIR/${BASE}_baseline7_to_baseline8.patch"
PACKAGES="$OUT_DIR/${BASE}_sample_training_packages.zip"
TESTLOG="$OUT_DIR/${BASE}_test_all.log"
SRCLOG="$OUT_DIR/${BASE}_source_rehydrate.log"
BUNDLELOG="$OUT_DIR/${BASE}_git_bundle_rehydrate.log"
PREFLIGHT="$OUT_DIR/${BASE}_android_sdk_preflight.log"
MANIFEST="$OUT_DIR/${BASE}_DELIVERY_MANIFEST.md"
FINAL="$OUT_DIR/${BASE}_FINAL_VERIFIED.txt"
BUILD_OK="$OUT_DIR/${BASE}_BUILD_OK.json"
COMPONENTS="$OUT_DIR/${BASE}_component_SHA256SUMS.txt"
ALLSUMS="$OUT_DIR/${BASE}_ALL_SHA256SUMS.txt"
COMPLETE="$OUT_DIR/${BASE}_complete_delivery.zip"
mkdir -p "$OUT_DIR" "$STATE"

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
  (cd "$checkout" && ./scripts/test_all.sh) 2>&1 | tee "$log"
}

case "$STAGE" in
prepare)
  require_clean_tag
  run_full "$ROOT" "$TESTLOG"
  grep -q ALL_GATE0_AND_GATEAB_BASELINE8_TESTS_PASS "$TESTLOG"
  make_package_zip
  rm -f "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PREFLIGHT"
  (cd "$ROOT" && git archive --format=zip --prefix="a620-cognitive-training-baseline8/" -o "$SOURCE" HEAD)
  (cd "$ROOT" && git bundle create "$BUNDLE" --all && git bundle verify "$BUNDLE" >/dev/null)
  (cd "$ROOT" && git diff --binary "$BASE7" HEAD > "$PATCH")
  (cd "$ROOT" && git archive --format=zip -o "$ANDROID" HEAD \
    gateab_runtime_shell/android \
    gateab_runtime_shell/android-jvm-stubs \
    gateab_runtime_shell/normative/android_runtime_shell_profile.json \
    gateab_runtime_shell/normative/android_controller_store_profile.json \
    gateab_runtime_shell/tools/generate_runtime_shell_profiles.py \
    gateab_runtime_shell/tools/generate_android_controller_store.py \
    gateab_runtime_shell/tools/test_baseline8.sh \
    gateab_runtime_shell/kotlin/src/main/kotlin/a620/shell \
    gateab_runtime_shell/kotlin/src/test/kotlin/a620/shell/Baseline8Main.kt \
    kotlin/src/main/kotlin/a620 \
    docs/HARDENING_BASELINE8_20260818.md \
    BASELINE8_HARDENING.md)
  set +e
  "$ROOT/gateab_runtime_shell/android/ci/android_sdk_preflight.sh" > "$PREFLIGHT" 2>&1
  rc=$?
  set -e
  echo "ANDROID_SDK_PREFLIGHT_EXIT=$rc" >> "$PREFLIGHT"
  case "$rc" in
    0) echo ANDROID_SDK_BUILD_AND_LINT_VERIFIED >> "$PREFLIGHT" ;;
    20|21|22|23|24) echo EXPECTED_ENVIRONMENT_LIMITATION_ANDROID_SDK_BUILD_NOT_CLAIMED >> "$PREFLIGHT" ;;
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
  grep -q ALL_GATE0_AND_GATEAB_BASELINE8_TESTS_PASS "$SRCLOG"
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
  grep -q ALL_GATE0_AND_GATEAB_BASELINE8_TESTS_PASS "$BUNDLELOG"
  echo GIT_BUNDLE_REHYDRATE_PASS >> "$BUNDLELOG"
  rm -rf "$tmp"
  echo GIT_BUNDLE_REHYDRATE_PASS
  ;;
assemble)
  for p in "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT"; do
    [[ -f "$p" ]] || { echo MISSING_$p >&2; exit 1; }
  done
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
Path(out).write_text(f'''# A620 Gate A/B rc3 baseline.8 交付清单

- 公共契约：`A620-TRC-1.1`
- 实现候选：`rc3-baseline.8`
- 状态：`GATE_AB_AUTHENTICATED_DURABLE_CONTROLLER_CANDIDATE_NOT_DEVICE_APPROVED`
- Git 分支：`{branch}`
- Git 提交：`{commit}`
- Git 标签：`{tag}`
- 日期：`20260818`

## 本轮实现

在 baseline.7 严格 canonical/PFD/有序入口基础上，新增每绑定 256-bit AIDL 通道令牌、同 UID 与 generation 双重 fencing、双向 inline/PFD 事件传输、A620-ACDS-1 SQLite v4 主控持久层、boot epoch/uptime 防回退、角色独立 senderSeq、持久 BATCH_CLOSED 证据、正式结果/同步队列/主控状态/提交 ACK/runtime finalization 单事务。对 `oneway Binder` 只认定为传输提交；Cocos 精确重放 RESULT_READY 时重新排队原始 ACK，且 outbox 只按最小未完成 senderSeq 串行发送并为未来 UTC 到期项安排唤醒。

## 自动证据

- Python：Gate 0 75 + baseline.5 28 + baseline.6 14 + baseline.8 68 = 185 项通过；
- TypeScript：Gate 0、baseline.5、baseline.6、baseline.8 通过；
- Kotlin/JVM：Gate 0、baseline.5、baseline.6、baseline.8 与 Android/AIDL stub 通过；
- SQLite v4 schema 和事务约束在 Python sqlite3 中执行通过；
- 两份样例训练包构建和验证通过；
- 源码 ZIP 与 Git bundle 各自独立全量还原通过。

## 规模

- 文本源码、规范、Schema、测试和文档：`{files}` 个文件；
- 总行数：`{lines}` 行（包含生成代码、测试与文档）。

## 限制

当前环境缺少 Gradle 9.5.0 与 Android SDK，所以未生成或宣称通过真实 APK、AGP AIDL 生成、Android lint、Room 生产接入或候选设备测试。当前持久化核心是直接 SQLiteOpenHelper 事务候选；真实 Binder/PFD、Cocos 进程、300 秒设备计时与断电恢复仍待验证。候选不能用于患者任务。
''',encoding='utf-8')
PY
  cat > "$FINAL" <<EOF2
A620_BASELINE8_FINAL_VERIFIED
contractVersion=A620-TRC-1.1
implementationCandidate=rc3-baseline.8
status=GATE_AB_AUTHENTICATED_DURABLE_CONTROLLER_CANDIDATE_NOT_DEVICE_APPROVED
branch=$branch
commit=$commit
tag=$TAG
mainTestSuite=PASS
pythonTests=185
sourceZipRehydrate=PASS
gitBundleRehydrate=PASS
sampleTrainingPackages=PASS
sqliteSchemaAndTransactionTests=PASS
androidSdkBuild=NOT_RUN_ENVIRONMENT_MISSING
roomProductionIntegration=NOT_IMPLEMENTED
wireSemanticChange=false
EOF2
  python3 - "$BUILD_OK" "$branch" "$commit" "$TAG" <<'PY'
from pathlib import Path
import json,sys
out,branch,commit,tag=sys.argv[1:]
obj={
 "contractVersion":"A620-TRC-1.1",
 "implementationCandidate":"rc3-baseline.8",
 "status":"GATE_AB_AUTHENTICATED_DURABLE_CONTROLLER_CANDIDATE_NOT_DEVICE_APPROVED",
 "branch":branch,"commit":commit,"tag":tag,
 "wireSemanticChange":False,
 "tests":{"python":185,"typescript":"PASS","kotlinJvm":"PASS","androidAidlStub":"PASS","sqliteSchema":"PASS","samplePackages":"PASS","sourceRehydrate":"PASS","gitBundleRehydrate":"PASS"},
 "notVerified":{"androidSdkBuild":True,"roomProductionIntegration":True,"realBinderPfd":True,"cocosTrainingProcess":True,"candidateTablet":True}
}
Path(out).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
PY
  sha256sum "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$MANIFEST" "$FINAL" "$BUILD_OK" > "$COMPONENTS"
  python3 - "$COMPLETE" "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$COMPONENTS" "$MANIFEST" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$FINAL" "$BUILD_OK" "$ROOT/docs/HARDENING_BASELINE8_20260818.md" <<'PY'
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
  sha256sum "$COMPLETE" "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$MANIFEST" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$FINAL" "$BUILD_OK" > "$ALLSUMS"
  unzip -t "$COMPLETE" >/dev/null
  echo DELIVERY_ASSEMBLE_PASS
  printf '%s\n' "$COMPLETE" "$SOURCE" "$BUNDLE" "$ANDROID" "$PATCH" "$PACKAGES" "$MANIFEST" "$TESTLOG" "$SRCLOG" "$BUNDLELOG" "$PREFLIGHT" "$FINAL" "$BUILD_OK" "$ALLSUMS"
  ;;
*) echo "Usage: $0 [out] {prepare|verify-source|verify-bundle|assemble}" >&2; exit 2 ;;
esac
