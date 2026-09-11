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
The harness first observes an authoritative empty Extension snapshot, creates
an Entry in Web, and requires its list update and password decryption in the
still-unlocked Extension before any relock. It then repeats the Entry assertion
after a fresh manual authorization and unlock snapshot. The restart step uses the browser's ServiceWorker
stop/start commands and requires observed `stopped` then `running` states while
the source Web document remains alive. It attaches the current native worker
target, then requires automatic unlock and actual Entry password decryption.
This proves a browser-controlled worker restart, not full browser/profile
shutdown. Offline/expiry, account mismatch and the other platforms remain
separate acceptance scenarios.

Add `--delay-manual-authorization` to delay the Web request that creates fresh
manual authorization by 1.5 seconds after shared lock. This changes transport
timing only and exposes repair reads of the previous locked root while the new
password unlock is preparing. The report records this option and the actual
delay. No API response, key state, clock, lock result, or token is substituted.

## Firefox Identity, Entry and background restart

`shared-unlock-firefox-identity.py` runs the same real registration, email,
password, encrypted Entry and shared-lifecycle flow on the Firefox product build.
Use the isolated backend configuration above. Also configure Web's
`VITE_SHARED_UNLOCK_FIREFOX_EXTENSION_ID` to the actual built manifest's Gecko
ID and build the Firefox target with the same explicit environment mapping.
Python's standard library, Node with built-in WebSocket, Firefox and geckodriver
are required. The driver creates and removes its own disposable profile.

```sh
python3 tests/browser/shared-unlock-firefox-identity.py \
  --firefox /absolute/path/to/firefox \
  --geckodriver /absolute/path/to/geckodriver \
  --web-source /absolute/path/to/built-web-repository \
  --api-url http://localhost:55083 \
  --ses-url http://127.0.0.1:55084
```

Geckodriver's `--allow-system-access` operates Firefox's native popup and its
real add-on DevTools target; it never turns the popup into an extension tab or
replaces the product sender. Popup buttons use DOM activation of their real
callbacks, so this test does **not** prove trusted-input or idle renewal.
The restart uses the same browser-owned `terminateBackgroundScript` operation
as about:debugging. It requires observed running→stopped→running states, leaves
the source Web document alive, then requires fresh automatic unlock and Entry
decryption. It does not reload the add-on or alter its session state.

Firefox's clipboard reveal restriction remains enforced. Instead, the test
saves a Credential for `https://shared-unlock-login.example.test` through Web
and verifies actual automatic password fill into an initially empty login form.
A BiDi network fixture supplies that controlled HTTPS document, and Firefox's
permission store grants only the declared optional host for that exact fixture.
The real extension's HTTPS, host, document, type and no-submit checks still run.
This proves decryption and fill in the browser, **not** a TLS handshake or the
browser's site-permission prompt UX. Password comparisons return only booleans;
there is no clipboard write, screenshot, injected key or mocked Identity result.

Reports under ignored `test-results/shared-unlock-firefox-identity/` record
value-free checks, artifact hashes, source heads, version and these limitations.
Versioned report/failure files retain results when another Firefox version runs;
the main report/failure files describe only the latest run. Later harness runs
also record whether each source working tree contains uncommitted changes.
The 2026-09-11 14:53:07Z run passed all 16 steps on Firefox 155.0.1, geckodriver
0.37.1, macOS 26.4.1 arm64 with a temporary product XPI. This is `partial-pass`:
Firefox 140–152 still requires full Entry-password/lifecycle compatibility;
the older-version acceptance, full OS/distribution matrix, other platforms, expiry,
tokenless/resume/key-use, mismatch and independent review remain required.

The new legacy-route build again passed all 16 steps on Firefox155 at15:22:41Z.
Firefox140 at15:21:45Z completed six checks plus the visible live Entry update,
then failed specifically at `live-entry-password-autofill`. The existing inline
autofill source guard requires native sender.documentId; MemberIndex visibility
is not treated as password proof. The subsequent lifecycle checks did not run
on140. Keep that failure as an open compatibility gate while completing the
legacy route and actual password/lifecycle acceptance.
