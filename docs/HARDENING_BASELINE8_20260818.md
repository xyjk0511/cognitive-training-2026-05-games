# A620 rc3-baseline.8 authenticated durable-controller hardening

- Contract: `A620-TRC-1.1`
- Candidate: `rc3-baseline.8`
- Status: `GATE_AB_AUTHENTICATED_DURABLE_CONTROLLER_CANDIDATE_NOT_DEVICE_APPROVED`
- Public wire semantic change from baseline.7: `false`

## 1. Internal channel fencing

The controller generates a new 32-byte lower-hex token for each binding. Token
and channel generation accompany every AIDL call and callback. Same-UID checks
remain mandatory; the token is defense-in-depth, not a replacement for Android
process identity. Async bulk work retains the channel fence and revalidates it
before parsing and before reducer mutation.

The service keeps the raw token only in volatile memory while it must echo the
token on callbacks. It keeps a SHA-256 digest for constant-time validation and
zeroes the stored digest on rotation. No token enters A620 wire JSON, result
hashes, package manifests or SQLite.

## 2. Bidirectional transport

Controller→training and training→controller both support bounded inline bytes
and large canonical payloads through `ParcelFileDescriptor`. PFD reads occur
off the single state actor, preserve accepted ingress order and are bounded by
message/byte/time budgets. Formal evidence cannot be silently discarded under
backpressure.

## 3. A620-ACDS-1 controller store

Schema v4 stores:

- one active runtime identity and immutable PREPARE facts;
- role-scoped sender sequence cursors and canonical event inbox;
- late terminal-event audit;
- durable `BATCH_CLOSED` evidence;
- mutually exclusive formal result or execution outcome;
- result sync queue using UTC retry deadlines;
- commit ACK outbox and controller state.

Runtime traffic is accepted only after `bindBootEpoch`. A different boot epoch
or uptime regression interrupts the active runtime; uptime values from different
boots are never compared as one timeline.

## 4. Formal result transaction

The commit path validates the canonical RESULT_READY, reconciles every eligible
batch with durable process evidence, derives the quality flag, then atomically
writes:

1. formal result;
2. pending-upload queue;
3. COMPLETE/PENDING_UPLOAD controller state;
4. canonical `ACK_RESULT_COMMITTED` outbox entry;
5. terminal runtime finalization.

Any failure rolls the transaction back. The ACK then leaves through a durable
outbox claim fenced by owner and claim generation. Binder submission failure
returns the same row to PENDING with a UTC retry deadline; it does not undo or
reclassify the committed result. An identical result retry returns the original
result ID, hash, timestamps and ACK bytes. `TERMINATE` or runtime failure writes
an execution outcome instead and cannot coexist with a formal result.

## 5. Oneway Binder delivery and ordered ACK replay

A successful `oneway` Binder return is treated only as transport submission. It
is not remote application acknowledgement. Cocos therefore retains the exact
`RESULT_READY` draft until it observes `ACK_RESULT_COMMITTED`. If that ACK was
submitted but not processed, an exact replay of the same RESULT_READY is checked
before the generic terminal-runtime audit path, reopens the original ACK outbox
row, and retransmits the same canonical bytes, message ID, sender sequence,
result ID and commit timestamps.

Controller outbox dispatch is strictly ordered by `senderSeq`. Priority affects
capacity admission only; it cannot leapfrog an earlier unresolved message. The
dispatcher also persists UTC retry deadlines and schedules the next wake-up after
process restart, so a future-due row cannot become permanently dormant.

## 6. Evidence and limits

Executed evidence includes Python SQLite schema/transaction tests, generated
profile hash checks, Kotlin/TypeScript contract tests and Android/AIDL JVM stub
compilation. The toolchain preflight confirms JDK 21 satisfies the JDK 17
minimum, but Gradle 9.5.0 and Android SDK are absent in this environment.

Therefore this candidate does **not** prove Android SDK buildability, Room
integration, real Binder/PFD behavior, Cocos process integration, device timing
or power-loss durability. It is not approved for patient use.
