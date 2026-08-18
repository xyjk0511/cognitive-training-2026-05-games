# A620 W1 Gate A/B Android device-shell candidate

This module is the single-APK Android source for the W1 platform line. It keeps
one exported launcher activity in the main process and one non-exported
`TrainingRuntimeService` in `:training`. The public wire remains A620-TRC-1.1.

Implemented source paths:

- `A620Application` opens the application-private `AndroidControllerStore`, runs
  SQLite quick/foreign-key/business-invariant checks, binds the Android boot
  epoch, and owns at most one execution attempt;
- `ControllerRuntimeClient` exposes a narrow command channel rather than raw
  AIDL and fences every call/callback by same UID, token and generation;
- both directions choose inline canonical JSON up to 49,152 bytes and bounded
  `ParcelFileDescriptor` pipes above that threshold;
- `TrainingRuntimeService` installs an engine-independent MockGame reducer for
  the 300,000 ms Gate A/B lifecycle, including pause/resume, 0/1/7/8 eligible
  batches, exact RESULT_READY replay and ACK commit acknowledgement;
- schema v4 is the authoritative live store. The only approved old-schema path
  archives v1 rows under `legacy_v1_*` and requires a new execution attempt; it
  never fabricates missing v4 identity or clears data.

Reproducible checks:

```bash
./scripts/test_platform_gateab.sh
./scripts/build_android_gateab.sh
```

`build_android_gateab.sh` runs `assembleDebug`, `testDebugUnitTest` and
`lintDebug` only after exact Gradle 9.5.0, Android platform 36, build-tools
36.0.0 and AIDL preflight. If those components are absent it exits 20 and emits
an explicit blocked report. JVM/AIDL stubs are separate evidence and are not an
APK build.

No candidate tablet, real Binder driver, real Android PFD, process-kill,
power-loss or 300-second wall-clock approval is implied by this source tree.
