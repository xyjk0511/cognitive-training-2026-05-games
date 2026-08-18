#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHELL_ROOT="$ROOT/gateab_runtime_shell"
OUT="${TMPDIR:-/tmp}/a620-platform-gateab-test-$$"
trap 'rm -rf "$OUT"' EXIT
mkdir -p "$OUT"

python3 "$SHELL_ROOT/tools/generate_android_controller_store.py" --check
python3 "$SHELL_ROOT/tools/generate_android_store_migration.py" --check
python3 -m pytest -q "$SHELL_ROOT/python/tests/test_platform_gateab_delivery.py"

ANDROID_COMMON_SOURCES=(
  "$ROOT/kotlin/src/main/kotlin/a620/CanonicalJson.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/Dto.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/GeneratedRuntimeProfiles.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/GeneratedStateMachineContract.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/IpcFrame.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/RetryPolicy.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/RuntimeStateMachine.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/RuntimeWireEnvelope.kt"
  "$ROOT/kotlin/src/main/kotlin/a620/StrictCanonicalJson.kt"
  "$SHELL_ROOT/kotlin/src/main/kotlin/a620/shell/AndroidShellProfile.kt"
  "$SHELL_ROOT/kotlin/src/main/kotlin/a620/shell/IngressBudget.kt"
  "$SHELL_ROOT/kotlin/src/main/kotlin/a620/shell/OrderedIngressSequencer.kt"
  "$SHELL_ROOT/kotlin/src/main/kotlin/a620/shell/PointerInputGate.kt"
  "$SHELL_ROOT/kotlin/src/main/kotlin/a620/shell/PriorityRuntimeActor.kt"
)
mapfile -t GENERATED_SHELL_SOURCES < <(find "$SHELL_ROOT/kotlin/src/main/kotlin/a620/shell/generated" -type f -name '*.kt' | sort)
mapfile -t ANDROID_STUB_SOURCES < <(find "$SHELL_ROOT/android-jvm-stubs/src" -type f -name '*.kt' | sort)
mapfile -t ANDROID_APP_SOURCES < <(find "$SHELL_ROOT/android/app/src/main/java" -type f -name '*.kt' | sort)

kotlinc -J-Xmx1536m -language-version 2.0 \
  "${ANDROID_COMMON_SOURCES[@]}" \
  "${GENERATED_SHELL_SOURCES[@]}" \
  "${ANDROID_STUB_SOURCES[@]}" \
  "${ANDROID_APP_SOURCES[@]}" \
  "$SHELL_ROOT/android-jvm-stubs/test/PlatformGateAbMain.kt" \
  -include-runtime -d "$OUT/platform-gateab-tests.jar"
java -jar "$OUT/platform-gateab-tests.jar"
echo "PLATFORM_GATEAB_TEST_SUITE_PASS"
