# A620 baseline.5 coordination hardening

This layer closes four implementation risks left outside the baseline.4
reference model:

1. concurrent duplicate message processing;
2. SQLite crash windows and stale worker fencing;
3. per-game package installation lock competition;
4. watchdog and retry scheduling races.

The implementation is intentionally engine-independent and uses SQLite
transactions as the reference semantics that Android Room/AIDL code must
preserve. Reducers passed to `apply_inbound_message` must be pure: external
side effects are emitted only through the durable outbox after commit.

Profiles:

- `A620-CCP-1`: concurrency and SQLite transaction profile;
- `A620-PIL-1`: package installation lease/fencing profile;
- `A620-RWC-1`: retry/watchdog coordination profile.

This is still a Gate 0 implementation candidate, not a production APK.
