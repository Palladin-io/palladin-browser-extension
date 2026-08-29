# Current Member Entry sync fixtures

The JSON fixtures in this directory are vendored verbatim from
`Palladin-io/palladin-protocol` commit
`f0d1563cf04eb790b5b8e3b28f974a6301338100`. Changes require a deliberate
protocol fixture re-pin and provider/consumer contract review.

This immutable fixture directory freezes sync policy `2` for CVT-555 while Vault wire protocol remains `2`. It is additive to `fixtures/v2`; neither the protocol registry nor sync policy `1` is rewritten.

The wire fixtures cover a complete `MemberIndex` + `MemberSecret` + `EntryKey` head, the current Member Vault-key wrapper and finite offline-access context, a MemberSecret at the 256 KiB ciphertext boundary, tombstone/reset controls, a response-byte page boundary, a snapshot race and all required mutation transitions. Negative fixtures substitute one independently authoritative binding at a time, test exact lease expiry, corrupt ciphertext and replay an old snapshot boundary.

All credentials, keys, IDs, nonces and plaintext are deterministic synthetic test data. They are invalid for production use. Production implementations must not reuse fixture nonces or keys.

Run `npm run generate:fixtures` and `npm test` from `contracts/vault-v2`. Generated JSON must never be edited by hand.
