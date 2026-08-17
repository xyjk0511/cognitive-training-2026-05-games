#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHELL_ROOT="$ROOT/gateab_runtime_shell"

python3 "$SHELL_ROOT/tools/generate_runtime_shell_profiles.py" --check
python3 "$ROOT/baseline6_hardening/tools/generate_storage_profiles.py" --check
python3 -m pytest -q "$SHELL_ROOT/python/tests"

rm -rf "$ROOT/build/baseline7-kotlin"
mkdir -p "$ROOT/build/baseline7-kotlin"
kotlinc \
  "$ROOT"/kotlin/src/main/kotlin/a620/*.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/*.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/generated/*.kt \
  "$SHELL_ROOT"/kotlin/src/test/kotlin/a620/shell/*.kt \
  -include-runtime \
  -d "$ROOT/build/baseline7-kotlin/runtime-ingress-tests.jar"
java -jar "$ROOT/build/baseline7-kotlin/runtime-ingress-tests.jar"

rm -rf "$ROOT/build/baseline7-android-common" "$ROOT/build/baseline7-android-stub"
mkdir -p "$ROOT/build/baseline7-android-common" "$ROOT/build/baseline7-android-stub"
kotlinc \
  "$ROOT"/kotlin/src/main/kotlin/a620/CanonicalJson.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/Dto.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/GeneratedRuntimeProfiles.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/GeneratedStateMachineContract.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/IpcFrame.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/RetryPolicy.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/RuntimeStateMachine.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/RuntimeWireEnvelope.kt \
  "$ROOT"/kotlin/src/main/kotlin/a620/StrictCanonicalJson.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/AndroidShellProfile.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/IngressBudget.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/OrderedIngressSequencer.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/PointerInputGate.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/PriorityRuntimeActor.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/generated/*.kt \
  -d "$ROOT/build/baseline7-android-common/android-common.jar"
kotlinc \
  -classpath "$ROOT/build/baseline7-android-common/android-common.jar" \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/content/pm/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/content/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/app/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/os/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/view/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/widget/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/com/a620/tablet/training/*.kt \
  "$SHELL_ROOT"/android/app/src/main/java/com/a620/tablet/*.kt \
  "$SHELL_ROOT"/android/app/src/main/java/com/a620/tablet/training/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/test/AndroidBaseline7Main.kt \
  -include-runtime \
  -d "$ROOT/build/baseline7-android-stub/android-scaffold-tests.jar"
java -cp "$ROOT/build/baseline7-android-stub/android-scaffold-tests.jar:$ROOT/build/baseline7-android-common/android-common.jar" com.a620.tablet.training.AndroidBaseline7MainKt
echo ANDROID_SCAFFOLD_JVM_STUB_COMPILE_AND_TEST_PASS

rm -rf "$SHELL_ROOT/typescript/dist"
tsc -p "$SHELL_ROOT/typescript/tsconfig.json"
node "$SHELL_ROOT/typescript/dist/gateab_runtime_shell/typescript/test/run-tests.js"

echo BASELINE7_GATEAB_RUNTIME_INGRESS_TESTS_PASS
