# Native shared-unlock Identity check

`shared-unlock-identity-e2e.mjs` drives the built Web panel and the actual native
Chromium popup against a running, isolated local backend. Registration, recovery
confirmation, email verification, password login, shared Identity consume/commit,
and Entry encryption/decryption use production code. It never injects a session
or keys. The only provider fixture is an in-memory SES v2 mail delivery endpoint;
the backend still issues and verifies the real one-time email token.

Use dedicated disposable PostgreSQL databases and RabbitMQ for this check. Do
not point it at a developer's existing accounts or services. Run the backend with
its normal checked-in migrations, email verification enabled, and ignored local
configuration pointing to these isolated services. For the configuration below,
bind the API to loopback port 55083, set the email verification URL to
`http://127.0.0.1:5173/verify-email`, and the SES service URL to
`http://127.0.0.1:55084`. The harness owns ports 5173 and 55084 for its duration.
Use synthetic local provider configuration; keep generated backend signing and
enumeration secrets in ignored local configuration, never this repository.

Build the Web panel with explicit `VITE_API_URL=http://localhost:55083`,
`VITE_SIGNALR_HUB_URL=http://localhost:55083/hubs/notifications`, and
`VITE_SHARED_UNLOCK_EXTENSION_ID` equal to the ID derived from the actual
Chromium manifest key. Keep analytics and push disabled for the test. Build the
extension with the same API URL and this explicit environment mapping:

```json
[{"apiUrl":"http://localhost:55083","webOrigin":"http://127.0.0.1:5173"}]
```

Pass it as `VITE_SHARED_UNLOCK_ENVIRONMENTS` to the Chromium build. The harness
serves the built Web `_headers`, including its actual CSP; it does not relax
browser security or patch either bundle. Install Playwright's Chromium before
running from the extension repository:

```sh
node tests/browser/shared-unlock-identity-e2e.mjs \
  --web-source /absolute/path/to/built-web-repository \
  --api-url http://localhost:55083 \
  --ses-url http://127.0.0.1:55084
```

Reports under ignored `test-results/shared-unlock-identity/` contain only check
names, sanitized request paths/statuses, source heads, artifact hashes, browser
version, and environment provenance. Passwords, recovery words, mail tokens and
decrypted fields remain in memory and never enter reports or screenshots. The
native popup invokes the same guarded `vault/reveal` command as CopyButton and
compares the result inside that popup; only a boolean returns to the harness.
This avoids writing a test password to the user's clipboard.

A successful run is deliberately `partial-pass`: it is local unpacked Chromium
evidence, not the complete browser/OS/distributed-artifact acceptance matrix.
The Entry assertion follows a fresh manual authorization and unlock snapshot;
it does not prove live invalidation delivery for Entries created after a peer's
initial empty snapshot. Restart, offline/expiry, account mismatch and the other
platforms remain separate acceptance scenarios.
