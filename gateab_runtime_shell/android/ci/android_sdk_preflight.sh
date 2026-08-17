#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/toolchain.lock.json"

command -v java >/dev/null || { echo "JDK_MISSING" >&2; exit 20; }
command -v gradle >/dev/null || { echo "GRADLE_9_5_0_MISSING" >&2; exit 21; }
[[ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]] || { echo "ANDROID_SDK_ROOT_MISSING" >&2; exit 22; }
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT}}"
[[ -d "$SDK/platforms/android-36" ]] || { echo "ANDROID_PLATFORM_36_MISSING" >&2; exit 23; }
[[ -d "$SDK/build-tools/36.0.0" ]] || { echo "ANDROID_BUILD_TOOLS_36_0_0_MISSING" >&2; exit 24; }

java_major="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
[[ "$java_major" == "17" ]] || { echo "JDK_17_REQUIRED_FOUND_${java_major:-unknown}" >&2; exit 25; }
gradle_version="$(gradle --version | sed -n 's/^Gradle \([0-9.]*\)$/\1/p')"
[[ "$gradle_version" == "9.5.0" ]] || { echo "GRADLE_9_5_0_REQUIRED_FOUND_${gradle_version:-unknown}" >&2; exit 26; }
python3 - <<'PY' "$LOCK"
import json,sys
p=json.load(open(sys.argv[1],encoding='utf-8'))
assert p['androidGradlePlugin']=='9.3.1'
assert p['gradle']=='9.5.0'
assert p['jdk']==17 and p['compileSdk']==36 and p['buildTools']=='36.0.0'
print('ANDROID_TOOLCHAIN_LOCK_CHECK_PASS')
PY

gradle --no-daemon --stacktrace -p "$ROOT" clean :app:assembleDebug :app:lintDebug
sha256sum "$ROOT/app/build/outputs/apk/debug/app-debug.apk"
echo ANDROID_SDK_BUILD_AND_LINT_PASS
