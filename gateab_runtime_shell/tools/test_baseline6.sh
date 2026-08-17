#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHELL_ROOT="$ROOT/gateab_runtime_shell"

python3 "$SHELL_ROOT/tools/generate_runtime_shell_profiles.py" --check
python3 "$ROOT/baseline6_hardening/tools/generate_storage_profiles.py" --check
python3 -m pytest -q "$SHELL_ROOT/python/tests"

rm -rf "$ROOT/build/baseline6-kotlin"
mkdir -p "$ROOT/build/baseline6-kotlin"
kotlinc \
  "$ROOT"/kotlin/src/main/kotlin/a620/*.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/*.kt \
  "$SHELL_ROOT"/kotlin/src/main/kotlin/a620/shell/generated/*.kt \
  "$SHELL_ROOT"/kotlin/src/test/kotlin/a620/shell/*.kt \
  -include-runtime \
  -d "$ROOT/build/baseline6-kotlin/runtime-shell-tests.jar"
java -jar "$ROOT/build/baseline6-kotlin/runtime-shell-tests.jar"

rm -rf "$ROOT/build/baseline6-android-stub"
mkdir -p "$ROOT/build/baseline6-android-stub"
kotlinc \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/content/pm/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/content/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/app/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/os/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/view/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/android/widget/*.kt \
  "$SHELL_ROOT"/android-jvm-stubs/src/com/a620/tablet/training/*.kt \
  "$SHELL_ROOT"/android/app/src/main/java/com/a620/tablet/*.kt \
  "$SHELL_ROOT"/android/app/src/main/java/com/a620/tablet/training/*.kt \
  -d "$ROOT/build/baseline6-android-stub/android-scaffold-compile.jar"
echo ANDROID_SCAFFOLD_JVM_STUB_COMPILE_PASS

rm -rf "$SHELL_ROOT/typescript/dist"
tsc -p "$SHELL_ROOT/typescript/tsconfig.json"
node "$SHELL_ROOT/typescript/dist/gateab_runtime_shell/typescript/test/run-tests.js"

echo BASELINE6_GATEAB_RUNTIME_SHELL_TESTS_PASS
