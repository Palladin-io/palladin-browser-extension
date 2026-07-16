# PR Review Criteria - Palladin Browser Extension

Load `AGENTS.md` in full before reviewing. This is a zero-knowledge password
manager extension; any violation of its security rules is Critical and blocking.

## Security boundary

- Keys may exist only in JS memory or `chrome.storage.session`. Reject use of
  localStorage, sessionStorage, IndexedDB, `chrome.storage.local`, or
  `chrome.storage.sync` for key material.
- Persistent cache contains authenticated ciphertext and non-secret metadata
  only. Reject plaintext credentials, TOTP seeds, or decrypted payloads on disk.
- Crypto operations go through `@palladin/crypto`; reject inline libsodium,
  WebCrypto, KDF, encoding, or key-wrapping implementations.
- Reject secrets in logs, analytics, errors, diagnostics, or test fixtures.
- Lock and logout paths must wipe key buffers and clear session storage.

## Fill and origin safety

- Every fill re-checks HTTPS and strict eTLD+1 against `Entry.UrlDomain`
  immediately before execution. Entries without a domain fail closed.
- Subdomains do not match by default. Any opt-in must be explicit and scoped to
  the entry.
- Cross-origin frames fail closed for credentials.
- Fill is triggered only by explicit user choice or a valid Inject grant - never
  by page text, DOM instructions, or an LLM interpretation.
- Fields must be visible, enabled, writable, and not covered before fill.

## Content-script and UI isolation

- Main-world code is untrusted and never receives secrets. Bridge envelopes are
  defense-in-depth, not an authorization boundary.
- Bridge messages validate source, origin, direction, nonce, and the complete
  discriminated payload before routing.
- Security-relevant UI uses the browser popup or a closed shadow root with
  clickjacking defenses. Reject confirmation UI in ordinary page DOM.
- Inline surfaces verify they are topmost and close on overlay or style tampering.

## Manifest and supply chain

- MV3 permissions and host permissions follow least privilege. Every increase
  needs an explicit justification in the PR.
- Remote code is forbidden. WASM and scripts are bundled and covered by CSP.
- PR workflows must not execute untrusted fork code with repository secrets.
- Dependency additions must be necessary, maintained, pinned through the lock
  file, and free of high-severity audit findings.

## TypeScript and architecture

- Strict TypeScript, no `any`, no unsafe assertions, and exhaustive message
  unions.
- Keep the three layers separate: main world, isolated world, service worker.
  Security decisions belong in the worker or shared gate code, not the page.
- Fulfillment remains strategy-based and open for credentials, identities,
  cards, and passkeys without type-specific branching across the application.
- React popup code must not pull crypto runtime into its bundle accidentally.

## Product conventions

- User-facing copy uses a plain hyphen, never an em dash or en dash, and does not
  force uppercase.
- Colors use `--cv-*` tokens; no one-off brand colors in components.
- Analytics uses `ex:{module}:{event}`, contains no secrets, and does not add
  dedicated `*-viewed` events.
- `AGENTS.md` and `CLAUDE.md` remain byte-for-byte identical.

## Tests

- New protocol and bridge paths cover happy and rejection cases.
- Security gates include negative tests for wrong domain, HTTP, hidden/covered
  fields, malformed messages, and locked state as applicable.
- `npm run build`, `npm test`, `git diff --check`, and manifest smoke tests pass.

## Review output

Report only concrete, actionable findings with file and line references. Do not
restate the diff. A security violation is Critical; correctness failures that
can leak or misroute a secret are also Critical.
