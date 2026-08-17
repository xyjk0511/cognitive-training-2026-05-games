#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHELL_ROOT="$ROOT/gateab_runtime_shell"

python3 "$SHELL_ROOT/tools/generate_runtime_shell_profiles.py" --check
python3 "$SHELL_ROOT/tools/generate_android_controller_store.py" --check
python3 "$ROOT/baseline6_hardening/tools/generate_storage_profiles.py" --check
python3 -m pytest -q "$SHELL_ROOT/python/tests"

rm -rf "$ROOT/build/baseline8-kotlin"
mkdir -p "$ROOT/build/baseline8-kotlin"
kotlinc -J-Xmx1536m \
  "$ROOT"/kotlin/src/main/kotlin/a620/*.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/*.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/generated/*.kt \
  "$SHELL_ROOT"/kotlin/src/test/kotlin/a620/shell/*.kt \
  -include-runtime \
  -d "$ROOT/build/baseline8-kotlin/runtime-ingress-tests.jar"
java -jar "$ROOT/build/baseline8-kotlin/runtime-ingress-tests.jar"

rm -rf "$ROOT/build/baseline8-android-stub"
mkdir -p "$ROOT/build/baseline8-android-stub"
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
kotlinc -J-Xmx1536m \
  "${ANDROID_COMMON_SOURCES[@]}" \
  "${GENERATED_SHELL_SOURCES[@]}" \
  "${ANDROID_STUB_SOURCES[@]}" \
  "${ANDROID_APP_SOURCES[@]}" \
  "$SHELL_ROOT/android-jvm-stubs/test/AndroidBaseline8Main.kt" \
  -include-runtime \
  -d "$ROOT/build/baseline8-android-stub/android-scaffold-tests.jar"
java -jar "$ROOT/build/baseline8-android-stub/android-scaffold-tests.jar"
echo ANDROID_SCAFFOLD_JVM_STUB_COMPILE_AND_TEST_PASS

rm -rf "$SHELL_ROOT/typescript/dist"
tsc -p "$SHELL_ROOT/typescript/tsconfig.json"
node "$SHELL_ROOT/typescript/dist/gateab_runtime_shell/typescript/test/run-tests.js"

echo BASELINE8_GATEAB_AUTHENTICATED_DURABLE_CONTROLLER_TESTS_PASS
