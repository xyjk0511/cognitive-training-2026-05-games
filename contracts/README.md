# Contracts

- `normative/`: human- and machine-readable protocol decisions.
- `schemas/`: Draft 2020-12 structural schemas.
- `test-vectors/`: cross-language canonical JSON and runtime flows.

JSON Schema only validates structure. Cross-field, cross-message, state, identity, ledger and transaction rules are implemented in `python/a620_gate0` and mirrored by TypeScript/Kotlin tests.
