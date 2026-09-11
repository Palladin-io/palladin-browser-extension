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

### Branded Chromium-family browsers

Use an explicit browser executable and label to run the same Identity/Entry
checks on Chrome, Brave, Edge or Opera. The harness always creates its own
temporary profile; it never attaches to an existing user profile. Verify the
vendor package/signature before running it. A label is an operator-supplied
report dimension, not proof of the browser vendor; reports also retain the
actual browser version, executable SHA256, OS version and built artifact hashes.

```sh
node tests/browser/shared-unlock-identity-e2e.mjs \
  --web-source /absolute/path/to/built-web-repository \
  --api-url http://localhost:55083 --ses-url http://127.0.0.1:55084 \
  --browser-label chrome \
  --browser-executable '/absolute/path/to/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --install-via-cdp --delay-manual-authorization
```

Current official Chrome no longer accepts `--load-extension`. The explicit
`--install-via-cdp` option uses the browser's `Extensions.loadUnpacked` command
over the automation pipe with `--enable-unsafe-extension-debugging`. It only
installs the actual unpacked artifact and checks its browser-returned ID against
the manifest-derived ID and worker origin. It never reads or writes extension
storage through the debugging API, installs keys, substitutes authentication or
relaxes Web CSP. This is development-installation evidence, not store evidence.
The option is independent of the browser label; engines that still support the
original load flag can use the default installation path.

`--totp` adds real Web enrollment after the initial Entry proof, then a fresh
password/TOTP login. It requires the enabled 2FA display, a shared logout, six
actual peer Entry-reveal denials while the password-only challenge is pending,
an Identity401 for a deliberately invalid code, and a correct fresh code followed
by peer unlock and actual password decryption. The test authenticator uses the
published crypto SDK; seed/codes remain in process memory, recovery codes are
never read or exported, and the server clock/replay protection are unchanged.
The original lifecycle scenario then continues with the MFA-authenticated session.
Reports use an additional `.totp` suffix. The first run stopped at the enabled
state after real enroll/confirm200: Identity GET account omitted totpEnabled,
so the Web still displayed disabled. Backend0bab2b6d adds the field; all15
GetAccount tests pass, including four cases that failed before the fix. The
complete native MFA rerun is still required. Pass `--backend-source` to record
that isolated running API checkout alongside both client source hashes.

`--full-browser-restart` adds a separate lifecycle case after both clients have
successfully unlocked and the restarted worker has decrypted the Entry. It closes
the entire browser, waits for disconnection, and reopens the same test profile
with unchanged launch arguments. The browser wakes the known registered worker;
its exact native target must exist. There is no second CDP installation command,
lock/logout, storage edit or restored key. Both clients must require
manual unlock; six actual private Entry reveal requests over three seconds must
return the worker's `locked` error with no reveal payload. One normal Web password
unlock must then automatically unlock the extension and decrypt the same Entry.
This is graceful full-browser-close evidence, not crash, OS-lock, sleep or
unbounded observation. Browser/profile closure and negative key-use assertions
are recorded separately from the existing worker-only restart.
Scenario-specific reports use the `.full-browser-restart.json` suffix so these
results do not replace the original16-check reports.

`--own-activity-during-prepare` holds the first link activation during the fresh
manual Web unlock, sends an ordinary browser keyboard event to that Web document,
requires an accepted own activity API response and waits200ms before releasing
the activation. The17-check scenario still requires the peer's actual unlock and
Entry decryption. Only the response status is recorded; no auth/key state is
injected. The `.own-activity-during-prepare.json` suffix separates these reports.
An HTTP200 observation is not proof of the exact time the client applied the
response. Deterministic coordinator tests separately pause preparation and crypto
creation, notify own authority, and verify cancellation plus a fresh attempt.

On Edge153.0.4234.32, the development `Extensions.loadUnpacked` installation was
absent after browser restart. A separate account-free probe confirmed the native
extension list contained the enabled artifact before closure and did not contain
it after reopening the same profile. A browser `startWorker` acknowledgment alone
is not evidence that the worker exists. This installation path cannot currently
prove Edge's full-browser restart gate; do not silently reinstall and count it
as persisted-installation acceptance.

Runs are headless by default and record that fact. `--headed` selects a visible
browser; neither mode by itself proves OS-lock/sleep, trusted idle renewal or
distribution acceptance. Versioned `report.<label>-<version>.json` and failure
files preserve observations across browsers; the unversioned files describe only
the latest run. The required matrix remains open for untested combinations.

After a manual Web logout, the harness waits for the document replacement owned
by `logoutAndReload`, not merely the intermediate SPA `/login` route. Input then
uses ordinary browser form filling and checks complete values without logging
them. Native popup button actions require an observed trusted click on the exact
button. A click that was delivered is never retried; a missing pointer delivery
may resolve the fresh button again. Reports retain the delivered Sign out click
attempt count. This instrumentation observes input delivery only and does not
change product handlers, session state or authentication.

References: [Chrome flag removal](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY),
[browser-owned extension installation](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked).

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

The private legacy fill transport subsequently passed all16 steps on
Firefox140.0/geckodriver0.37.1/macOS26.4.1 arm64 at15:58:29Z on2026-09-11,
including actual password autofill, Web closure/reopening, browser-controlled
background restart and shared manual lock/logout. The versioned report records
the working-tree build and artifact hash. An earlier new run stopped at email
verification and did not reach fill; it is retained separately as failure
evidence. The passing temporary-XPI observation resolves that run's password
compatibility failure, but does not complete the version/OS/distribution matrix
or the remaining expiry, account-isolation and independent-review gates.


After the own-source coordinator fix (Web1314dec/Extension runtime3444a75),
the unchanged Firefox harness repeated all16 steps on140.0 at18:01:57Z and155.0.1
at18:02:48Z on2026-09-11. Both used clean source trees, Extension62fc2ef,
macOS26.4.1 arm64 and geckodriver0.37.1. Source heads and artifact hashes are in
the versioned reports; the previous810cf86 results were retained separately.
These are actual password/lifecycle observations, without adding trusted-input,
full-browser restart, TLS, permission-prompt or full-platform acceptance.
