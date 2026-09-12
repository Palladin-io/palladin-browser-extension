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
Chromium manifest key. Set the required `VITE_GOOGLE_CLIENT_ID` to the nonworking
test value `synthetic-cvt583-test.apps.googleusercontent.com`; Google login is
not used. Keep analytics and push disabled for the test. Build the
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

Add `--independent-idle-expiry` for the real 15-minute Web idle limit. The Web
receives no input while browser-generated, trusted mouse movements in the native
popup keep the extension active. The test requires Web expiry near its normal
deadline, removal of its decrypted Entry form, and continued extension Entry
decryption. It observes another repair interval, reloads Web, and observes a
second repair interval to reject automatic revival of an expired own session.
Both intervals also bound operation creation to one new-channel attempt, so a
denied expired receiver cannot repeatedly reconnect and exhaust the server limit.
Finally a new manual password unlock must restore Web Entry decryption. The
scenario takes at least 15 minutes; it does not shorten a policy, change clocks,
inject activity messages or mutate authentication/key state. This tests one
direction of idle independence, not absolute/offline expiry or OS sleep/lock.

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

`--settings` uses real SPA navigation and native popup controls for default-on,
Web OFF/Extension ON propagation, existing-session independence while OFF,
explicit disconnect cancellation/confirmation in both clients, and fresh manual
unlock after explicit reconnect. Every locked Extension assertion invokes the
actual private Entry reveal path. It also checks that a disconnected client can
unlock itself without silently reconnecting or unlocking its peer.

The first attempt's hard navigation wiped Web's own keys while OFF; the test now
uses the actual Settings/Security links. The next attempt exposed a product bug:
Extension's locally sealed expiry was slightly later than its own server session,
so manual source authorization returned409 and closing repair relocked the client.
Backend PR57 caps requested ceilings to the authoritative own refresh expiry,
preserves expired/misordered rejection and returns the exact stored limits.
Three new overshoot cases first failed; all34 authorization tests and CI pass.
Backend PR57 passed one independent review without findings and merged asba60ff52
at2026-09-11T21:23:13Z; deployment is not confirmed.
The native rerun passed29 checks at2026-09-11T21:15:35Z on clean Web6dcb1db /
Extension8f5df51 / Backenddde6bb96, Chromium153.0.8010.12/macOS26.4.1 arm64.
It covers both disconnect/reconnect directions; it is local unpacked evidence.

`--account-isolation` adds a separate password-only two-account scenario after
shared logout. It signs back into A, switches A OFF through real settings, signs
Web out, and registers/verifies/logs into B through the actual product UI. B has
its own default-ON preference while Extension A remains OFF. A is then switched
ON through the native popup. Both clients must decrypt different actual Entries;
Extension A must reject B's Entry with `decrypt-failed` and no reveal payload.
Lock/reload of Web B leaves A decrypting and B locked; manual B unlock restores
only B. Lock of Extension A leaves Web B decrypting and A locked; manual A unlock
preserves both identities. Finally, Web B logout must preserve A Entry access.
No key/session/cache state is injected; SES verification is scoped to each of the
two synthetic recipients and remains in memory. This option excludes `--totp`;
MFA/account-change combinations remain separate acceptance work.
`--account-logout-direction extension` selects the inverse final operation:
Extension A signs out, while Web B must keep decrypting its Entry and retain the
exact Entry route for 32 observations at 500ms intervals. A main-frame navigation
listener also rejects a transient logout followed by automatic unlock. This
covers the 15-second closing repair interval, not unbounded observation. The
default direction is `web`; inverse reports add `.extension-logout`.

Chromium153.0.8010.12/macOS26.4.1 arm64 passed25 checks at2026-09-11T21:38:16Z
on clean Web6dcb1db / Extensiondb17016 / Backenddde6bb96;9 account-isolation checks
plus the original16 lifecycle checks. Runtime artifacts are unchanged. The first
run stopped after20 checks because the driver inspected the newly reloaded page
before waiting for the unlock form to mount; the driver now waits for that form.
The later successful run also requires the exact cross-account rejection code.
The first failure remains in `failure.account-isolation-first.json`. Chrome's
first attempt stopped at21 checks on the account B Entry list after manual unlock
at21:39:54Z; the cause remains unresolved. A diagnostic rerun reached the independent
Extension A lock/unlock at21:41:42Z but lost its native popup target. The driver now
opens a fresh native popup before locking A and after its manual Unlock click;
no sender guard or client state is changed. Both failures remain recorded.


Google Chrome152.0.7977.84 passed25 checks at2026-09-11T21:44:04.138Z on Web6dcb1db /
Extension79a0e20 / Backenddde6bb96. Only this documentation was pending in the
Extension tree; runtime artifacts are unchanged. The native popup is reopened
at explicit driver boundaries. The prior Entry-list timeout remains unresolved;
this pass does not claim that intermittent behavior is fixed.

`--account-unlock-cycles N` repeats the independent Web B lock/reload/manual
unlock and real Entry decryption, bounded to1–5 cycles and requiring account
isolation. Each completed cycle is recorded; the report suffix preserves the
chosen count. Five cycles passed with the full flow:33 checks at2026-09-11T21:49:16Z
on clean Web6dcb1db / Extensionaf45b0a / Backenddde6bb96, Google Chrome152.0.7977.84,
macOS26.4.1 arm64, local CDP unpacked. This did not reproduce the prior Entry-list
timeout and does not resolve it. Error evidence now also distinguishes the Web's
actual encrypted Vault-list and Entry-index synchronization messages.

`--settings-races` additionally aborts a real Web preference PUT and requires
the visible local-pause error while the account remains ON. A new Web document
must remain locked even while the existing Extension can decrypt the Entry;
an explicit retry then saves the failed OFF choice. It holds a subsequent Web
PUT until the Extension writes the same old revision, then requires an actual
Identity409, the conflict display, and a successful explicit retry at the current
revision. No response, session, key or account preference is injected. These
race scenarios passed with the remaining lifecycle flow:20 checks at2026-09-11T21:23:14Z
on Web6dcb1db / Extensione50b5f8 / Backenddde6bb96, Chromium153/macOS26.4.1.
The extension tree had only this documentation update pending; runtime artifacts
were unchanged. The first race run lost its native popup when a new tab became
active; the driver now opens a fresh native popup for that real browser transition.
The combined TOTP/settings/races/own-activity/full-browser-restart run passed41
checks at2026-09-11T21:26:39Z on clean Web6dcb1db / Extension63191a5 /
Backenddde6bb96, Chromium153/macOS26.4.1 arm64. Google Chrome152.0.7977.84
subsequently passed38 checks on those same clean sources and artifacts, using
CDP unpacked installation and worker restart, without full-browser restart.
Both runs include actual Entry access/denial, reopened Web automatic unlock and
shared lock/logout. Normal Extension CI34649231437 and Web CI34646663177 passed.
These are local-unpacked results; the full OS/version/distribution matrix remains.
The earlier combined attempt timed out in automatic handoff during full-document
settings navigation. Enrollment now follows real SPA Settings/Security links.
The distinct reopen-Web test passed in the combined runs; that earlier intermittent
handoff failure is not claimed as resolved. Safari remains last by owner decision;
CI34649231397 product boundary failed, while classic/module/document passed.

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
next run exposed a second product defect: the generic Web401 handler cleared
the pending challenge and reloaded the login page after a correctly rejected
code. Web6dcb1db gives pre-login requests a transport without session recovery;
its two regression cases first failed, then the full Web suite passed2024 tests.
An intervening native run stopped before registration because its rebuilt Web
artifact omitted the required synthetic Google configuration; that is not MFA
evidence. The earlier exact-label test-selector correction is4257a8f.

The configured rerun on2026-09-11 at20:55:50Z passed24 checks with clean
Web6dcb1db / Extension4257a8f / Backend0bab2b6d, Chromium153.0.8010.12,
macOS26.4.1 arm64, local unpacked distribution. It includes actual incorrect
then correct TOTP, six password-only peer reveal denials, own source activity,
worker restart, same-profile full browser restart with both clients locked and
real reveal denied until a fresh manual unlock, reopening Web, shared lock/logout.
Web artifact SHA256:0fcc3d2b67ed6aa8db5f4d9cb22c00e3385e4f7225788a5350afc505339a4375.
Extension artifact SHA256:84080ad8e306e9ecf756c6129a500d8bef8242064f10cfb0ae1013906fd14880.
Google Chrome152.0.7977.84 passed21 checks at20:56:37Z on the same clean sources
and artifacts, using the browser-owned CDP unpacked installer. This includes
actual TOTP and worker restart, but does not claim full-browser restart. Backend
PR56 subsequently passed independent review without findings and merged as29c7d4b2.
This is partial native evidence; factor-age expiry, recovery codes and the full
platform/settings/account/lifecycle matrix remain required. Pass `--backend-source`
to record that isolated running API checkout alongside both client source hashes.

For Chrome, Edge, Brave and Opera installed through CDP, full restart requires
`--persist-via-browser-ui`. Before creating any account, this uses the browser's own
Reload button on the exact installed extension card. Chrome, Brave and Opera
use `chrome://extensions`; Edge uses `edge://extensions` and its own custom
card UI. The Edge adapter reads the browser-owned card ID and clicks the native
Reload control; it does not mutate card data or call internal installer methods.
An account-free probe confirms this normal unpacked installation survives full
closure in all four tested browsers; CDP-only installation is not persistent. The harness
checks the browser registry for the original ID and enabled state after restart,
without reinstalling or changing storage. Provenance records
`browser-owned-cdp-bootstrap-and-extensions-ui-reload`; report names add
`.browser-ui-persisted`. This remains local-unpacked evidence.

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
is not evidence that the worker exists. The CDP-only path does not prove
persistence. The optional pre-account browser-UI Reload above supplies the
persistent installation; after restart the test independently checks the same
registered ID and native worker. Never silently reinstall and count it as
persisted-installation acceptance.

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


Failure diagnostics also record browser-error categories, failed-request origin
classes/resource types and browser error codes, CSP-error presence, document
readiness/root child count, known-heading visibility and a boolean indicating
whether the verification-token parameter remains present. They never include
console/error text, token/query values, request bodies, screenshots or DOM dumps.
These observations diagnose load/navigation failures before a handoff is reached;
a later passing retry does not close an unexplained earlier failure.

## Linux container reproduction

`shared-unlock-linux-fixture.mjs` runs the same Identity harness and forwards its
scenario flags. Prepare **disposable clean Git clones** named `extension`, `web`
and `backend` under a fixture directory, plus `reports/`. Copy only the already
configured local `dist/` artifacts into the two client clones. Do not mount
personal profiles, local credentials/configuration, the Docker socket, or the
original working repositories. The backend clone supplies provenance for the
isolated host API actually running on55083; it does not start a different API.

Inside the container, `/work/extension`, `/work/web`, `/work/backend` refer to
those clones. The fixture forwards loopback55083 and54583 byte-for-byte to the
host's isolated API and LocalStack. Port55085 forwards to the harness's RAM-only
SES server on127.0.0.1:55084; publish it **only** on host127.0.0.1:55084, which the
isolated backend already uses. It never rewrites requests or substitutes auth,
keys, signatures, clocks or responses. The normal Web CSP and extension allowlist
remain unchanged, with Web at127.0.0.1:5173 inside the container.

Use a Playwright image matching the locked package version. The observed run used
`mcr.microsoft.com/playwright@sha256:a0f4498920a5dbac63196d9140ed738ef00470f27e2e74029abd8850b7bd5717`
(Playwright1.63.0, Ubuntu24.04.4, linux/arm64), `--init --shm-size=1g --cpus=2
--memory=3g`, a bind mount of the disposable fixture directory at`/work`, and
`--publish 127.0.0.1:55084:55085`. Install dependencies in the extension clone with
`npm ci --ignore-scripts --no-audit --no-fund`, then run from that clone:

```sh
node tests/browser/shared-unlock-linux-fixture.mjs \
  --full-browser-restart --delay-manual-authorization \
  --own-activity-during-prepare --totp --settings --settings-races \
  --authorization-rate-limit-retry
```

Retain the ordinary value-free report, `/work/reports/container-environment.json`,
and the **host-observed** Docker image/digest/events separately. A value declared
inside the fixture is not independent image provenance. The successful initial
run used the equivalent temporary wrapper on clean Extensiond7f3c5c, Web2cacf2d
and Backenddde6bb96; it passed43 checks at2026-09-12T01:01:36.051Z, including
real429/Retry-After12s. Report: `report.chromium-linux-arm64-full-restart.json`.
The container was removed after completion; its cloned source/artifacts/reports
remain local and ignored. This is headless Linux arm64 browser/lifecycle evidence
in a Docker Desktop VM, not desktop OS-lock/sleep, x64, Windows or store evidence.
