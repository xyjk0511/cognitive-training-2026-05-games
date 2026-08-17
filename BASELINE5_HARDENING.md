# A620-TRC-1.1 rc3-baseline.5 hardening

baseline.5 keeps the baseline.4 wire protocol and product semantics, and
adds an executable reference for four runtime hazards that only appear
once multiple processes/workers operate on the same durable state:

- concurrent duplicate inbound processing;
- stale worker commits after lease takeover;
- outbox retry racing a watchdog timeout;
- two package installers racing for one game slot.

The normative decision at equal uptime is **watchdog before retry**.
Runtime terminalization, pending-outbox cancellation, active-watchdog
cancellation, and the execution outcome are one SQLite transaction.
Package activation pointer, release floor, and journal commit are one
SQLite transaction. Fencing tokens prevent an expired owner from
committing after takeover.

This reference does not convert the project into a production Android
implementation. Gate A/B still requires Room/AIDL/Binder, a Cocos process,
MotionEvent input gating, process-death tests, and candidate-device tests.
