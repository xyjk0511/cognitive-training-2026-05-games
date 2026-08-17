# A620 Gate A/B Android-shaped runtime shell — baseline.6

This layer moves the project from a protocol/reference model toward a real
Android host shape without changing the `A620-TRC-1.1` wire contract.

## What baseline.6 adds

- `A620-ARS-1` transport and process-isolation profile.
- Small canonical control messages remain inline; large result payloads are
  transported through a hash-bound file-descriptor/bulk handle.
- Binder callbacks are reduced through one bounded single-consumer actor.
- A half-open uptime-millisecond input gate is available as pure Kotlin and as
  an Android `MotionEvent` source scaffold.
- Binder/process death invalidates the channel and creates an interrupted
  execution outcome; no automatic mid-session resume is permitted.
- A deterministic Kotlin MockGame exercises an eight-batch, 300-second logical
  session, pause/resume, result handoff, idempotent commit, and new-attempt
  isolation.
- An Android Studio source scaffold contains unexported `:training` service,
  AIDL definitions, manifest, and SQLite schema. It is intentionally not
  claimed as SDK-built in this environment.

## Deliberate non-goals

- No patient-task production APK.
- No Room-generated implementation yet.
- No Cocos Creator native project yet.
- No device approval and no production signing key.
- No game-specific L1 implementation.

The JVM/TypeScript/Python tests validate the implementation semantics. The
Android source scaffold still requires Android SDK compilation, lint,
instrumentation, process-kill testing, and candidate-tablet measurement.
