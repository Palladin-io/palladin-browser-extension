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
- The pin contains only the host public signing key and its derived fingerprint
  in extension local storage. No host or session secret is persisted. The popup
  accepts the strict `palladin.inject-pairing.v1` JSON bundle printed by the
  trusted runtime CLI, recomputes the fingerprint, and writes the pin only after
  explicit user confirmation. There is no TOFU path and Native Messaging cannot
  create or replace the pin.
- Playwright and AgentBrowser use their own provider adapters and do not connect
  to this extension.

## Secret lifecycle

1. Establish an authenticated Palladin session without persisting bearer
   credentials to durable extension storage.
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
reimplemented in popup, content-script, or service-worker handlers.

## Messaging contract

Messages should form a discriminated union with runtime validation at each
boundary. Protocol changes require tests for valid messages and for rejection
of wrong source, direction, frame, origin, nonce, type, payload, and session.

Messages must carry the minimum data needed for one operation. Broad state
snapshots and generic `unknown` payload relays make review harder and are not an
acceptable extension point.

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

## Build and release boundary

A resumed implementation should produce auditable, reproducible Chromium
artifacts first. Firefox or Safari support should use small reviewed manifest
overlays rather than forks of the security-critical core.

Release work must add, at minimum, locked dependencies, type checking, unit and
integration tests, permission-diff review, artifact hashes, an SBOM, provenance
attestation, and a documented browser-store signing process.
