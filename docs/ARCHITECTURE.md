# Architecture

This document describes the implemented development architecture. It is not a
claim that the extension has passed its production release gates.

## Trust boundaries

```text
untrusted page main world
          |
          | narrow, validated window messages
          v
isolated-world content script
          |
          | typed extension messages
          v
background service worker  <---->  extension popup
          |                              |
          | Native Messaging             | HTTPS API
          v                              v
Palladin local runtime              Palladin services
```

The popup owns only non-secret presentation preferences. `language` defaults to
the browser UI language and `theme` defaults to `prefers-color-scheme`; explicit
EN/PL and Light/Dark overrides are persisted in `chrome.storage.local`. Runtime
copy comes from exact-parity locale catalogs, while manifest/store-facing copy
uses MV3 `_locales`. Theme tokens mirror the web panel and never alter the
worker's session, key, or authorization state.

- The page main world is controlled by the visited site. It is never a trust
  anchor, even if a message contains a nonce that page scripts can observe.
- The isolated-world script validates shape, direction, frame, origin, and
  session context. It should receive a plaintext value only for an approved,
  immediate fill.
- The background service worker owns session and authorization gates. A page
  message alone can never authorize secret access.
- Security-relevant confirmation belongs to extension-owned UI. A visited page
  must not be able to read, restyle, or overlay it.
- The same extension has two separate callers: user autofill and Agent Inject.
  User autofill never authorizes Agent access. Agent Inject requires a pinned
  host signing key plus a signed ephemeral session and AEAD-protected frames;
  Native Messaging host allowlisting alone is not treated as authentication.
- Durable pairing state contains only the host public signing key, its derived
  fingerprint, and an opaque non-secret mutation-intent token in extension
  local storage. An active pin is accepted only when its token matches the
  latest successfully written durable intent, so later active-record writes
  restart fail-closed after that intent commits. If the intent write fails, the
  worker attempts to remove the active record, which restarts unpaired when
  successful. If both storage operations fail, the current worker stays
  suppressed and the UI instructs the user to retry before restarting, because
  durable revocation cannot be claimed.
- A synchronous runtime mutation barrier blocks reconnect and new Inject
  admission, then drains fills admitted before the barrier. A DOM message that
  was already dispatched may finish before this linearization point, but Pair or
  Clear cannot commit the active record or return success until it finishes and
  its values are wiped. Therefore no old fill can write after mutation success.
  No host or session secret is persisted. The popup
  accepts the strict `palladin.inject-pairing.v1` JSON bundle printed by the
  trusted runtime CLI, recomputes the fingerprint, and writes the pin only after
  explicit user confirmation. There is no TOFU path and Native Messaging cannot
  create or replace the pin.
- Playwright and AgentBrowser use their own provider adapters and do not connect
  to this extension.

## Secret lifecycle

1. Establish an authenticated Palladin session without persisting bearer
   credentials to durable extension storage.
   Password authentication uses the shared `identity-argon2id-password-v1`
   profile and strict bootstrap/account-state binding. A pending TOTP challenge
   owns only its derived master key in worker memory, is bound to the exact API
   URL and lifecycle generation, and is wiped on cancel, logout, server change,
   or failed completion; the popup never retains the master password.
2. Keep cryptographic keys only in service-worker JavaScript memory. A worker
   restart loses them; explicit lock and logout wipe them immediately.
3. Persist only canonical ciphertext envelopes and structural sync cursors in
   IndexedDB; decrypt only at the latest point
   required for a user-approved operation.
4. Bind preparation to the active tab and browser-issued top-frame document ID,
   then validate the isolated page-load ID, exact HTTPS origin, registered
   domain, and authorization again immediately before filling.
5. Drop plaintext references after use and clear temporary byte buffers where
   the platform permits it.

The extension uses the shared Palladin cryptographic package for canonical Vault
Protocol 2 envelopes and the Inject secure session. Cryptography is not
reimplemented in popup, content-script, or service-worker handlers. Extension
pages allow the narrow Manifest V3 CSP source `wasm-unsafe-eval` solely because
that reviewed package instantiates its bundled WebAssembly module; generic
`unsafe-eval`, remote scripts, and remote WebAssembly remain prohibited.

## Messaging contract

Messages should form a discriminated union with runtime validation at each
boundary. Protocol changes require tests for valid messages and for rejection
of wrong source, direction, frame, origin, nonce, type, payload, and session.

Messages must carry the minimum data needed for one operation. Broad state
snapshots and generic `unknown` payload relays make review harder and are not an
acceptable extension point.

Chrome closes long-lived extension ports when a page enters the back/forward
cache. The isolated content script consumes that expected disconnect and opens
a new typed port when the preserved document is restored. The normal
top-frame/document/origin checks still apply to every fill after reconnection.

Agent Inject uses `palladin.inject-provider.v1`. The local runtime decrypts an
approved Inject grant and transfers one credential over private pipes to the
Native Messaging host. A paired session begins with `session.open` /
`session.ready`; the signed transcript binds the extension origin, both nonces,
and both ephemeral keys. All prepare/inject traffic then travels only in
sequence-checked AEAD `secure` frames. The extension validates replay state,
active tab/document, HTTPS origin, and the authenticated runtime-provided target
domain before fill and before submit. It returns only a value-free outcome. The
declarative payload remains `form+values`; there is no CDP transport. Removing
the pin immediately disconnects and disposes the channel. Production host
packaging and installed-browser validation remain release gates, so this path is
not enabled in release builds today.

User card fill is a separate explicit popup action. It maps canonical card data
only to standardized `cc-name`, `cc-number`, expiry, and explicitly billing
address autocomplete fields. It does not infer payment fields from labels or
generic custom fields.

Copy is exposed only on Chromium, where an offscreen document performs the
reviewed TTL clipboard wipe. Firefox and Safari hide the control, and their
workers reject copy reveal/arm commands before requesting plaintext.

## Browser permissions

The manifest is security-sensitive source code. Every permission and host must
have a documented consumer and threat analysis. Prefer temporary `activeTab`
access and narrow hosts over persistent access. A proposed `<all_urls>` content
script requires explicit security review and is not an assumed default.

The production, staging, and default localhost API origins are install-time host
permissions. An HTTPS self-hosted origin or `127.0.0.1` is requested only after
the user submits its exact URL in extension-owned Settings; the service worker
checks that permission again before committing the change. HTTP is rejected for
every non-loopback host. The persisted setting contains only the normalized,
non-secret API base URL. A changed URL first terminates the current session,
wipes in-memory keys, and clears the ciphertext cache. Session tokens carry the
exact issuing API URL and are rejected and cleared if they do not match the
current server, so a token can never cross a server boundary.

The service worker owns a generation/lease barrier for this transition. Login,
TOTP, refresh, popup Vault commands, capture writes, unlock refresh, and periodic
sync hold a lease across the complete operation. A server mutation closes new
admission, drains the old generation, invalidates any background-owned TOTP
challenge, logs out, clears every IndexedDB ciphertext-cache partition, commits
the new URL, and only then reopens admission. Optional permission cleanup runs
inside the same serialized transition; popup contexts never remove permissions
from stale pre-change state.

## Build and release boundary

A resumed implementation should produce auditable, reproducible Chromium
artifacts first. Firefox or Safari support should use small reviewed manifest
overlays rather than forks of the security-critical core.

Release work must add, at minimum, locked dependencies, type checking, unit and
integration tests, permission-diff review, artifact hashes, an SBOM, provenance
attestation, and a documented browser-store signing process.
