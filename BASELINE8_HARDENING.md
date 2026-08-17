# baseline.8 summary

Authenticated same-UID AIDL channel, bidirectional inline/PFD events, and the
A620-ACDS-1 SQLite controller transaction scaffold were added without changing
public A620-TRC-1.1 canonical wire semantics. See
`docs/HARDENING_BASELINE8_20260818.md` and `gateab_runtime_shell/README.md`.

## Final ACK reliability hardening

- `oneway` Binder return is transport submission, not Cocos application acknowledgement.
- Exact `RESULT_READY` replay requeues the original committed ACK before terminal late-audit handling.
- ACK replay preserves canonical bytes, result/message IDs, sender sequence and first commit times.
- Outbox dispatch follows the smallest unresolved `senderSeq`; priority cannot reorder wire history.
- Future UTC retry deadlines schedule a durable wake-up after reconnect/restart.
