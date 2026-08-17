# A620 rc3-baseline.7 runtime-ingress hardening

## Version status

- Contract: `A620-TRC-1.1`
- Implementation candidate: `rc3-baseline.7`
- Wire semantic change from baseline.6: `false`
- Status: `GATE_AB_RUNTIME_INGRESS_CANDIDATE_NOT_DEVICE_APPROVED`

## Defects closed

1. **Bulk PFD I/O blocked the only state actor.** Bulk reads, length checks,
   hashing and strict parsing now run on a bounded I/O executor. Only validated
   messages enter the reducer actor.
2. **Normal traffic could consume all queue admission.** Urgent and normal
   traffic have separate message/byte budgets. Maximum bulk `RESULT_READY`
   payloads fit the urgent byte reserve.
3. **Naive priority could break causality.** Reserved capacity affects
   admission only. Execution remains FIFO by accepted ingress ordinal, and an
   ordered ingress sequencer prevents a later fast inline message from passing
   an earlier slow bulk message.
4. **AIDL metadata was not tied to canonical bytes.** `messageType`,
   `messageId` and `senderSeq` are repeated in AIDL and compared to the strict
   canonical envelope. Mismatch is a protocol violation.
5. **Raw JSON parsing was not implemented on the Kotlin ingress path.** The new
   parser rejects malformed UTF-8, duplicate keys, floats, unsafe integers,
   malformed surrogates, non-canonical escaping and extra bytes.
6. **Touch streams could become stuck at a boundary.** A gesture accepted
   before cutoff but released at/after cutoff now yields `CANCEL_STREAM`, not a
   silently dropped UP event.
7. **Controller callbacks were placeholders.** Both directions now share the
   same bulk budget, hash check, strict parser, generation check and ordered
   actor path.
8. **Toolchain declaration could be mistaken for an actual APK build.** The
   generated lock explicitly records that dependency resolution, Gradle
   wrapper, Android SDK build and device approval have not occurred.

## Admission and order policy

- Urgent capacity: 32 messages / 4 MiB.
- Normal capacity: 64 messages / 1 MiB.
- Bulk in-flight: at most 4 messages / 4 MiB.
- Bulk canonical payload maximum: 2 MiB.
- Droppable under normal-lane pressure: `HEARTBEAT`, `STATE_SNAPSHOT` only.
- `BATCH_CLOSED`, `RESULT_READY`, deadline/termination and commit messages are
  non-droppable.
- Priority never permits a later message to overtake an earlier accepted
  message in the same channel.

## Validation evidence

The candidate must pass inherited Gate 0, baseline.5 coordination,
baseline.6 storage integrity, baseline.7 Kotlin/Android-stub/TypeScript/Python
and sample training-package tests. Android SDK build and device tests remain a
separate unmet gate.
