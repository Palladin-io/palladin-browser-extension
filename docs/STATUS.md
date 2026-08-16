# Project status and restart gates

The repository contains development artifacts for one shared extension core:
Chromium-family MV3, Firefox, and a Safari conversion foundation. It includes
canonical Vault Protocol 2 user autofill and explicit write paths. Agent Inject
keeps its separate provider contract but its Native Messaging transport is
fail-closed until the user explicitly verifies and pins the local runtime. It
remains pre-production and has no supported production version until every
release gate below is complete.

`main` remains the authoritative product surface. Work starts from current
`main` and arrives through normal review; historical prototype branches are not
release candidates.

## Development baseline

- One buildable source tree with a locked dependency graph.
- CI and local tests cover messaging, session lock/wipe, ciphertext-only cache,
  canonical writes, domain matching, credential/card fill, payment-field
  exclusions, Agent fill, replay rejection, and logging redaction.
- One Chromium artifact targets Chrome, Edge, Brave, and Opera; Firefox and
  Safari use manifest overlays over the same core.
- The popup defaults to the production API. Settings can select staging,
  localhost, or an HTTPS self-hosted API through an exact optional host
  permission. A change signs out and clears the local encrypted cache, and
  stored session tokens are bound to their issuing API URL.
- Copy is available only in the Chromium artifact, where the reviewed offscreen
  TTL wipe exists. Firefox and Safari hide Copy and reject copy commands before
  decrypting a value.
- Card storage/autofill supports cardholder, PAN, expiry, billing, and notes.
  Canonical custom fields stay neutral and are never inferred as payment
  authentication data; there is no dedicated field or heuristic for it.
- The Native Messaging host name and authenticated session framing are explicit
  and tested. No `session.open` is sent without a pinned signing key/fingerprint.
- The extension-owned popup accepts only the strict out-of-band pairing bundle
  printed by `palladin browser install`, derives and verifies the public-key
  fingerprint, and requires explicit user confirmation before persisting the
  public pin. Saving connects; unpairing disconnects and disposes immediately.
  After a durable non-secret intent succeeds, interrupted clear/re-pair writes
  restart fail-closed. An in-memory mutation barrier suppresses new work and
  drains already-dispatched fills before pairing success. If both the intent
  write and fallback active-pin removal fail (a successful fallback restarts
  unpaired), the current worker remains suppressed and the user must retry
  before restarting; no durable revocation guarantee is claimed for total
  storage failure. Plaintext and TOFU fallbacks do not exist.
- Development compatibility targets current Chrome, Chromium, Brave, Edge, and
  Opera MV3 builds. Store certification and version support are not yet claimed.

## Additional gates for any release

- independent security review of the consolidated implementation;
- threat model updated from observed code rather than prototype assumptions;
- reproducible production build and reviewed store manifest;
- dependency audit, SBOM, artifact hashes, and build provenance;
- browser-store signing, update, rollback, and incident-response procedures;
- end-to-end tests against a compatible public Palladin API contract;
- trusted-runtime pairing with an independent user-verification channel and
  installed-browser Native Messaging tests;
- replace the temporary Git SHA crypto dependency with the reviewed published
  `@palladin/crypto` semver release before merge/release;
- release notes that distinguish implemented behavior from future work.

Until every release gate is complete, documentation and UI must continue to use
experimental language and must not ask users to trust the extension with real
credentials.
