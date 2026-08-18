# W0 Interactive Training Game Companion SPI

## Scope

`A620InteractiveTrainingGameModule` is an internal TypeScript host SPI layered on top of `A620TrainingGameModule`. It does not add or change any `A620-TRC-1.1` message, payload field, state transition, clock rule, or acknowledgement.

The host-only SPI supplies:

- externally injected monotonic uptime advancement;
- stable pointer-event identity, pointer stream identity, integer coordinates and an optional renderer hit token;
- explicit PAUSE/DEADLINE/TERMINATE input-stream cancellation;
- a durable-acceptance boundary for `EligibleBatch` evidence;
- explicit retry of unacknowledged evidence.

## Evidence sink contract

`setEvidenceSink()` installs a synchronous durable-acceptance callback. The initial sink must be installed before START; after a failed delivery it may be replaced before retry. Returning normally means that the host has durably accepted the immutable batch evidence. Throwing means the transaction did not commit.

On sink failure:

1. game-domain scoring, level transition and batch closure remain committed exactly once;
2. the same immutable `batchPayloadSha256` remains pending;
3. `retryPendingBatchEvidence()` redelivers it in ordinal order;
4. a sink callback may not re-enter lifecycle, input or evidence-delivery methods;
5. host-visible exactly-once behavior is provided by persistent deduplication, not by changing the public wire.

At the active-time cutoff, the host must call `advanceToUptime(cutoffUptimeMs)` and durably accept every resulting `BATCH_CLOSED` while the public runtime state is still `RUNNING`. Only then may it apply the internal duration transition to `FINALIZING` and call `onDeadline`. Both game adapters reject interactive `onDeadline` or result construction while batch evidence remains unpersisted; neither emits `BATCH_CLOSED` from `FINALIZING`.

Catch Light uses its existing pending notification queue. Signal Station uses a non-destructive pending read plus ordered hash acknowledgement; W0 replaced its previous destructive drain behavior.

## Pointer contract

`TrainingPointerEvent` contains only host-owned input metadata:

- `pointerEventId`: stable event deduplication key;
- `pointerId`: native stream identity;
- `phase`: `DOWN`, `MOVE`, `UP` or `CANCEL`;
- `sourceUptimeMs`: Android-provided monotonic uptime;
- integer `xPx` / `yPx` coordinates;
- nullable `hitToken` resolved by the renderer.

Only `DOWN` enters current game scoring. Repeated `pointerEventId` values and a second DOWN on the same active `pointerId` are ignored. If dispatch fails before the touch is applied, the gate rolls back that DOWN so the same stable event can be retried. PAUSE, DEADLINE and TERMINATE cancellation clears active host pointer streams without synthesizing a hit.

## Verification

Run:

```bash
./scripts/test_game_integration.sh
```

The test drives both games through the same companion interface, injects a first-attempt host persistence failure, retries the same evidence, and reconciles delivered batch ordinals/hashes against each final `eligibleBatches` array.

## Limitations

This is reference TypeScript/headless integration evidence. It is not evidence of a real Cocos process, Android Binder/PFD transport, AGP build, candidate-tablet timing, production signing, Gate A/B approval or patient readiness.
