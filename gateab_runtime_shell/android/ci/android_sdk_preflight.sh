#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/toolchain.lock.json"
errors=()

if ! command -v java >/dev/null; then
  errors+=("JDK_MISSING")
  java_major=""
else
  java_major="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
  if [[ -z "$java_major" || "$java_major" -lt 17 ]]; then
    errors+=("JDK_17_OR_NEWER_REQUIRED_FOUND_${java_major:-unknown}")
  else
    echo "JDK_MINIMUM_CHECK_PASS actual=$java_major minimum=17"
  fi
fi

GRADLE_BIN=""
if [[ -x "$ROOT/gradlew" && -f "$ROOT/gradle/wrapper/gradle-wrapper.jar" ]]; then
  GRADLE_BIN="$ROOT/gradlew"
elif command -v gradle >/dev/null; then
  GRADLE_BIN="$(command -v gradle)"
else
  errors+=("GRADLE_WRAPPER_OR_SYSTEM_GRADLE_MISSING")
fi
if [[ -n "$GRADLE_BIN" ]]; then
  gradle_version="$($GRADLE_BIN --version | sed -n 's/^Gradle \([0-9.]*\)$/\1/p')"
  if [[ "$gradle_version" != "9.5.0" ]]; then
    errors+=("GRADLE_9_5_0_REQUIRED_FOUND_${gradle_version:-unknown}")
  else
    echo "GRADLE_VERSION_CHECK_PASS actual=$gradle_version"
  fi
fi

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$SDK" ]]; then
  errors+=("ANDROID_SDK_ROOT_MISSING")
else
  [[ -d "$SDK/platforms/android-36" ]] || errors+=("ANDROID_PLATFORM_36_MISSING")
  [[ -d "$SDK/build-tools/36.0.0" ]] || errors+=("ANDROID_BUILD_TOOLS_36_0_0_MISSING")
fi

python3 - <<'PY' "$LOCK" "${java_major:-0}"
import json,sys
p=json.load(open(sys.argv[1],encoding='utf-8'))
actual=int(sys.argv[2])
assert p['androidGradlePlugin']=='9.3.1'
assert p['gradle']=='9.5.0'
assert p['jdkMinimum']==17
if actual:
    assert actual >= p['jdkMinimum']
assert p['compileSdk']==36 and p['targetSdk']==36 and p['buildTools']=='36.0.0'
print('ANDROID_TOOLCHAIN_LOCK_CHECK_PASS')
PY

if ((${#errors[@]})); then
  printf '%s\n' "${errors[@]}" >&2
  echo "ANDROID_SDK_PREFLIGHT_BLOCKED count=${#errors[@]}" >&2
  exit 20
fi

"$GRADLE_BIN" --no-daemon --stacktrace -p "$ROOT" clean :app:assembleDebug :app:lintDebug
sha256sum "$ROOT/app/build/outputs/apk/debug/app-debug.apk"
echo ANDROID_SDK_BUILD_AND_LINT_PASS
