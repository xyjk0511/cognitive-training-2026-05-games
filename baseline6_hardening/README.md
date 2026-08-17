# A620 rc3-baseline.6 storage-integrity hardening

This layer corrects gaps discovered while auditing baseline.5 rather than
adding another wire protocol revision.  It keeps `A620-TRC-1.1` wire bytes
unchanged and hardens the executable Python/SQLite reference semantics.

Closed risks:

1. persisted JSON is decoded with the same A620-JCS-1/JRP implementation as
   the wire layer, including UTF-16 key ordering and duplicate-key rejection;
2. snapshots, inbox outcomes, outbox obligations, watchdog details and package
   manifests are hash-verified before use;
3. baseline.5 databases receive an explicit versioned migration; unknown
   future schemas are rejected;
4. uptime values cannot move backwards within one monotonic epoch;
5. a package-install epoch change clears stale leases and aborts uncommitted
   installs instead of comparing timestamps across boots;
6. NULL watchdog sources are normalized so SQLite uniqueness is effective;
7. any due watchdog for a runtime wins over any ACK at the same millisecond;
8. open-time and on-demand integrity checks verify SQLite, hashes and
   cross-table lifecycle invariants.

This remains a reference implementation.  Android Room/AIDL and Cocos native
process integration are not present and Gate 0 is not approved.
