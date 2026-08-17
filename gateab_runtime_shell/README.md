# A620 Gate A/B authenticated durable controller — baseline.8

`rc3-baseline.8` preserves the public `A620-TRC-1.1` canonical wire bytes and
hardens the same-APK controller/training boundary plus controller persistence.

## Added in baseline.8

- A fresh 256-bit opaque token is generated for every main-process binding.
  Every AIDL request and callback carries token + generation. The service
  enforces same UID, stores only the token digest for validation, compares in
  constant time, and fences stale asynchronous work before parse and reducer.
- The raw AIDL interface remains behind `ControllerRuntimeClient`; callers use
  authenticated wrappers. The training process can send controller events by
  bounded inline or `ParcelFileDescriptor` transport.
- `A620-ACDS-1` / schema v4 defines application-private SQLite records for
  PREPARE identity, role-scoped sender cursors, canonical inbox events, late
  audit, batch evidence, formal result, execution outcome, sync queue, commit
  ACK outbox and controller state.
- PREPARE and runtime traffic must match a previously bound boot epoch. Uptime
  regression inside that epoch fails closed; retries across reboot use UTC.
- `BATCH_CLOSED` evidence is reconciled exactly against the final game payload.
  Formal result, sync queue, controller state, commit ACK and runtime
  finalization are written in one transaction.
- The commit ACK is delivered by a fenced durable outbox dispatcher. Binder
  submission failure retries the original canonical bytes/message identity and
  never rewrites an already committed formal result as interrupted.
- An identical result retry returns the first committed facts and canonical ACK;
  result and interruption outcome remain mutually exclusive.
- Android toolchain preflight accepts JDK 17 or newer. The current JDK 21 stub
  compilation is evidence only, not an Android SDK build.

## Deliberate implementation boundary

The transaction core currently uses `SQLiteOpenHelper` directly. A future Room
facade may be added only if it preserves the same database schema, boot fencing,
message idempotency and one-transaction result commit. baseline.8 does not claim
that Room, real AIDL code generation or a production APK is complete.

## Still not complete

- No Android SDK `assembleDebug`, lint or instrumentation result.
- No Room entities/DAO/migrations proven against a device database.
- No real Binder/PFD or Cocos Creator `:training` process.
- No candidate-tablet process kill, 300-second timing or power-loss test.
- No game-specific L1 implementation.

This candidate is not approved for patient use.
