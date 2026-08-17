# A620 Gate A/B runtime ingress hardening — baseline.7

`rc3-baseline.7` hardens the Android-shaped runtime shell without changing the
`A620-TRC-1.1` canonical wire bytes.

## Added in baseline.7

- Strict bounded Kotlin parser for canonical A620 JSON. It rejects malformed
  UTF-8, duplicate keys, whitespace/non-canonical encoding, floats, unsafe
  integers and malformed surrogate pairs.
- The internal AIDL interface carries `messageType`, `messageId` and
  `senderSeq` beside the canonical bytes. The receiver must compare all three
  with the embedded envelope before reducer mutation.
- Bulk `ParcelFileDescriptor` reads and SHA-256 verification run outside the
  single state actor with an independent in-flight budget and 15-second lease.
- Binder ingress order is retained while bulk reads complete asynchronously;
  `RESULT_READY` cannot pass an earlier `BATCH_CLOSED`.
- Urgent traffic has separately reserved admission capacity, but does not
  violate causal FIFO. `HEARTBEAT` and `STATE_SNAPSHOT` may be dropped under
  backpressure; formal evidence and terminal messages may not.
- Touch streams that cross pause/deadline/termination boundaries return
  `CANCEL_STREAM`, requiring the Cocos adapter to deliver or synthesize an
  `ACTION_CANCEL` before discarding the old gesture.
- Controller callbacks use the same strict ingress boundary as
  controller-to-training messages.
- Android toolchain versions are generated into `toolchain.lock.json`, with an
  SDK build/lint preflight script. This environment did not contain the Android
  SDK, Gradle 9.5.0 or dependency-network access, so an Android SDK build is not
  claimed.

## Still not complete

- No Android SDK `assembleDebug`/lint/instrumentation result.
- No generated Room implementation or production reducer wiring.
- No Cocos Creator native project or native touch-to-Cocos cancel adapter.
- No candidate-tablet Binder/PFD latency, process-kill or 300-second timing test.
- No game-specific L1 implementation.

This candidate is not approved for patient use.
