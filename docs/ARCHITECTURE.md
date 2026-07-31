# Proposed architecture

This document is a design boundary for future work. It does not describe code
available on the default branch.

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
          |
          | authenticated, least-privilege API/native-runtime channel
          v
Palladin services or local runtime
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

## Secret lifecycle

1. Establish an authenticated Palladin session without persisting bearer
   credentials to durable extension storage.
2. Keep keys in JavaScript memory or `chrome.storage.session`, which is cleared
   with the browser session. Explicit lock and logout wipe them immediately.
3. Fetch ciphertext and structural metadata; decrypt only at the latest point
   required for a user-approved operation.
4. Validate the active tab, exact frame, HTTPS state, registered domain, and
   authorization again immediately before filling.
5. Drop plaintext references after use and clear temporary byte buffers where
   the platform permits it.

The extension must use the shared Palladin cryptographic package once a reviewed
package boundary is selected. Cryptography must not be reimplemented in popup,
content-script, or service-worker handlers.

## Messaging contract

Messages should form a discriminated union with runtime validation at each
boundary. Protocol changes require tests for valid messages and for rejection
of wrong source, direction, frame, origin, nonce, type, payload, and session.

Messages must carry the minimum data needed for one operation. Broad state
snapshots and generic `unknown` payload relays make review harder and are not an
acceptable extension point.

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
