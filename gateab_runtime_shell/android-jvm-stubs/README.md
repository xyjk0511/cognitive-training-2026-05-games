# JVM compile-only Android stubs

These minimal classes are test-only compile stubs. They are not shipped in the
APK and do not emulate Android behavior. Their sole purpose is to catch Kotlin
syntax/type drift in the Android source scaffold when the Android SDK is absent.
Real approval still requires AGP/AIDL compilation and instrumentation tests.
