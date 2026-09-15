# Safari recipient and document boundary

## Real Identity scenario

The owner moved remaining Safari acceptance to the end of CVT-583 on2026-09-11.
This reorders work; Safari and its full original matrix are not accepted or removed.
Local remote automation and the developer-features setting were restored to their
original disabled states, and Safari Settings showed no synthetic test extension.
The final local attempt at20:25:17Z timed out during installation, before Identity.
Safari's automation glass pane was observed; Continue Session was selected only
on that identified browser dialog. The failed run did not confirm session deletion
or return an installed ID. The native settings check, rather than that failed
cleanup response, establishes absence of the test extension. The test-server path
fix below has not yet received a complete native rerun.

`shared-unlock-safari-identity.py` uses the real Web registration/password flow,
the isolated backend and RAM-only SES delivery. It builds Web with the exact
Safari identifier returned by native installation, explicitly disables optional
cloud integrations, and serves the original generated CSP headers. Private Web
bundles live in a temporary directory and are deleted during cleanup; never upload
them to this public repository's CI artifacts.

The scenario is implemented but has not yet passed. It requires Safari26's
native resource installer and owner-enabled local remote automation. It does not
enable that setting, modify a user profile, accept a local native permission
dialog automatically or introduce a private-repository checkout in PR CI.
During setup the owner grants only the already declared127.0.0.1 host through
Safari's normal permission dialog. Backend and Web use distinct loopback ports;
the product still checks exact configured origins.

The first local run715b076 on macOS26.4.1 arm64 stopped at Safari session
creation at19:46:42Z with the bounded category `remote-automation-disabled`.
No account/Identity check ran. The configured Safari build, Python syntax,
fixture JavaScript checks and staged secret scan passed. The actual Popup helper
passed separately in CI34640667500 at19:48:09Z:15 account-free channel/UI checks,
including the product's onboarding button and reopening a fresh Popup that
retains the completed onboarding choice. Ordinary CI34640667407 also passed.
That result does not validate the unexecuted Identity flow or Web build step.
Repeat34641036018 timed out during close/reopen after14 checks. A native
control-page click also failed to dismiss the Popup in34641471862; the new
stages explicitly observed the old view still present and not closed. Dismissal
then tried native Escape only with Safari and a recognized test window frontmost.
Run34641976140 at20:03:18Z showed Safari's automation glass pane asking whether
to stop the test session, so that OS-key helper was removed. No stop/disable
automation action was taken. The current candidate schedules a fixed
`window.close()` task from an added Popup-owned script, then requires the native
view to disappear. It accepts no arbitrary code or privileged command and needs
no system UI permission. This candidate still needs a native pass; earlier
successes do not erase the recorded failures.

The later1a99079 run34642556171 stopped earlier, after11 checks at
native-popup-view-authority (20:08:47Z); it never reached the close candidate.
Its normal Test workflow34642556174 passed. Owner-approved local runs then
reached native installation and the exact loopback grant, but found a test-server
HTTP403 before registration. Canonicalizing the temporary Web root fixes the
macOS /var versus /private/var comparison without weakening traversal checks.
The Web build supplies a clearly synthetic Google client ID for the existing
required startup field, and points public assets only to the isolated local host.
The temporary session uses only the normal non-secret language preference for
English selectors. Cleanup explicitly uninstalls the browser-returned extension
ID and deletes the WebDriver session, recording only bounded cleanup outcomes.

Prepare the isolated backend as in [Identity setup](SHARED-UNLOCK-IDENTITY.md),
with API55083, verification links targeting127.0.0.1:5173 and SES delivery55084.
Read the Web repository's instructions before invoking its build. Then run:

```sh
VITE_API_URL=http://127.0.0.1:55083 VITE_POSTHOG_KEY='' \
VITE_SHARED_UNLOCK_ENVIRONMENTS='[{"apiUrl":"http://127.0.0.1:55083","webOrigin":"http://127.0.0.1:5173"}]' \
npm run build:safari
python3 tests/browser/shared-unlock-safari-identity.py --web-source /path/to/palladin-react-web-panel --prepare-only
# After the local Safari automation prerequisite is satisfied:
python3 tests/browser/shared-unlock-safari-identity.py --web-source /path/to/palladin-react-web-panel
```

The installed fixture copies the actual built extension, preserving permissions
and all product modules. Instrumentation adds a synthetic display name, a private
control page, a fixed Popup-own-realm close function and a wrapper that statically
imports the unchanged worker. Popup
controls use native `extension.getViews` and the product's own React handlers;
they never call privileged APIs through the control page. Native boundary CI
separately tests this UI mechanism, including a fresh Popup after onboarding.

The Entry has a new random encrypted username. Every extension decryption check
closes and reopens the actual Popup first, so a retained React value cannot pass
the check. Only equality booleans reach the test. The scenario covers Web→Extension
unlock, fresh manual unlock, extension decryption after Web closure, reopened Web
unlock plus decryption, both lock directions and Extension→Web logout. It does
not claim password autofill, worker/full-browser restart, trusted input/idle,
Safari16.4, signed distribution or the full matrix. Those gates remain required.
Reports under ignored `test-results/shared-unlock-safari-identity/` contain only
fixed stages/checks, provenance, hashes and bounded WebDriver error categories.
Preparation or a failure before Identity is not an accepted E2E result.

## Installed product channel

The latest helper validation715b076 passed15 checks in run34640667500 at19:48:09Z.
It adds real product onboarding activation and a closed/reopened native Popup
to the13 checks below. Clean CI merge checkout9d668fa681be17da4666febd9a4b256c3fe3bd34;
the original artifact and fixture hashes are unchanged from7deb6c9 below.
The latest product probe7deb6c9 passed13 checks in run34639004301 at19:29:17Z
on Safari26.6.2/macOS26.6.2 arm64. Ordinary CI34639004324 also passed.
The three added checks distinguish native Popup authority from a tab: opening
the Popup URL as a tab is rejected, and calling its runtime API from another
extension tab retains that caller's tab identity. A fixed read-only script loaded
inside the actual native Popup receives `signed-out` through the unchanged
private-command guard, with its exact native ID/URL and no sender tab.

Earlier run34637914020 incorrectly expected a tab copy to pass that guard.
Run34638324611 found the real Popup with `extension.getViews`, but its API call
still had the diagnostics tab's sender. These were harness assumptions, not
reasons to weaken the product guard. The successful probe adds an explicit
Popup-document script alongside the existing diagnostic instrumentation. It
uses no eval, session/key injection or private-command relay. This remains
instrumented, account-free evidence; real Identity/MK/Entry is still pending.
The clean CI merge checkout was fabdf86cd892e65d04f1506a330e6126ee51a1b8
for branch head7deb6c9. Original artifact SHA256 is unchanged from below;
instrumented fixture SHA256 is
`c70a714dd7a98a32409f82f37402e8cb7287e25ac4f5b2e8b4f2314ab12f4231`.

First native run34636215449 (test2de8417) disconnected before ready. The later
minimal diagnostic run34636880642 (02e2658) showed the product worker loaded
without recorded errors and confirmed the native current document. The cause
was a remaining Safari-only empty-environments override in `vite.config.ts`.
Fix16ab8ea has a three-target build regression with Safari RED then GREEN;
its native product run34637021800 passed10 checks at19:07:35Z. Intermediate diagnostic runs
34636552105/34636635182 failed because an optional event-inspection method was
not available; that test-only dependency was removed. The product worker is
imported statically, preserving its original module-loading semantics.


Safari26.6.2/macOS26.6.2 arm64 product result: native ready bound to an
independent current-document query, new document/channel after reload, and
rejection of wrong API, extra hello claim, repeated hello, wrong recipient and
wrong port on the already granted host. Product worker reports loaded with no
recorded errors. All three synthetic variants and ordinary CI34637021792 also
passed. The checkout is GitHub's clean PR merge commit
`fde9b808fe3673ec6e3fccecfe3c97abcf17418a` for branch head16ab8ea, not a main
release. Original Safari artifact SHA256:
`12741b0d2ab5233a96041dcb27c289a06a0d3af0ed070338c4391afc4af8fb16`;
instrumented fixture SHA256:
`ef877637ed24ca89f51d6653bdf88ac0e54230847d40da0b461d3115569efb52`.

The `--product-extension dist/safari` mode installs a copy of the actual Safari
build configured for Web `http://127.0.0.1:55189` and API
`http://localhost:55083`. It retains the original product worker and permissions.
Test instrumentation changes the display name, adds a private diagnostic page,
a fixed sender/status script to the Popup document, and a wrapper that imports
the unchanged product worker. The diagnostic page
requests only the already declared loopback host and reads native tab/document
metadata independently of the product's ready message. It never installs an
account, session or key. Source/artifact and instrumented fixture hashes are
recorded separately; this is not an unmodified distributed artifact proof.

The test requires a product ready frame, its exact native document binding, a
new document/channel after reload, and rejection of another API, extra hello
claims, repeated hello, another recipient and another port on the granted host.
The CI product job builds only this repository; it uses no private checkout or
backend secrets. The three synthetic background probes remain separate jobs.
Actual Identity/MK/Entry and supported-version/distribution acceptance remain
open until their own scenarios run successfully.

```sh
VITE_API_URL=http://localhost:55083 VITE_POSTHOG_KEY='' \
VITE_SHARED_UNLOCK_ENVIRONMENTS='[{"apiUrl":"http://localhost:55083","webOrigin":"http://127.0.0.1:55189"}]' \
npm run build:safari
python3 tests/browser/shared-unlock-safari-boundary.py --product-extension dist/safari
```

The same owner-approved local Safari automation prerequisite applies. The CI
native grant helper remains restricted to disposable GitHub-hosted runners and
the exact synthetic display name plus loopback host; it does not change local
Safari settings.

The product now contains a separate Safari native-Port adapter. The synthetic
mode described below tests a fixture, not product login/unlock. It removes
global `tabs` permission and checks the lifecycle event APIs and native tab
URL/status required by the adapter. Earlier nine-check results below belong to
the earlier fixture with `tabs`; they do not prove the new permission scope.

Run34634982018 found `webNavigation.onTabReplaced` absent in all three Safari26
background variants. The remaining lifecycle events and host grant were present.
The adapter now treats replacement events as optional and requires fresh native
tab/document lookups before each operation; a removed tab cannot keep its route.
The probe preserves that observation and requires only the events actually used.

The corrected d188270 fixture passed10 checks in all three variants in
workflow34635229213: classic18:47:47Z, module18:47:43Z, document18:47:31Z.
Safari26.6.2/macOS26.6.2 arm64, host grant with no global `tabs` permission.
The browser returns exact tab URL/status, normal-profile flags and matching
sender/current-frame document IDs. Module fixture SHA256:
`254c15b0eeacaeacd1af228a10a4f0c2c847fc1d88ad149c9457f3cb8542d800`.
No Identity or keys were used; this remains synthetic evidence.

CVT-587/CVT-592/CVT-604, within CVT-583. The following historical observations
established the synthetic browser route and packaging preparation. They do not
prove Identity/MK/Entry acceptance; the current product adapter is covered above.

Apple documents native webpage messaging through `browser.runtime.connect` and
`externally_connectable`. For packaged extensions the recipient is a composed
bundle/team identifier. This provides a candidate browser-owned recipient route;
the peer must not supply its own expected identity. Safari's native sender and
current-document metadata, navigation retirement, normal-profile behavior and
packaged-artifact identity must still be observed before using this route for MK.

Safari26 adds a WebDriver Classic extension installation command. It is an
explicit POST to `/session/{id}/webextension` with a resource path, not an
arbitrary capability echoed in the session response. The probe uses this native
command and the returned browser identifier to address the installed fixture.
The fixture reports only native routing metadata. It has no account, keys,
credentials, crypto, backend or native broker.

```sh
python3 tests/browser/shared-unlock-safari-boundary.py --prepare-only
# Requires Safari's owner-approved Allow remote automation setting.
/usr/bin/safaridriver -p 55187
# In a second terminal:
python3 tests/browser/shared-unlock-safari-boundary.py
```

The harness serves a synthetic loopback page on55189, creates its own SafariDriver
session, installs the fixture, and checks native connect/top-frame sender,
independence from forged payload claims, same-URL reload observations, a wrong
recipient and an unlisted Web origin. It records tab incognito status and any
native document/frame metadata rather than assuming these capabilities exist.
Missing native document IDs are observations, not a passed document-binding gate.
Session and server cleanup run on failure. Ignored reports live under
`test-results/shared-unlock-safari-boundary/` and contain no Identity data.

## Native containing-app preparation

The fixture can also be packaged by the installed Xcode converter:

```sh
xcrun safari-web-extension-converter \
  test-results/shared-unlock-safari-boundary/fixture \
  --project-location /tmp/cvt583-safari-wrapper \
  --app-name 'CVT583 Safari Boundary' \
  --bundle-identifier org.example.cvt583.boundary \
  --macos-only --swift --copy-resources --no-open --no-prompt
```

Xcode26.4's converter produced different identifier prefixes for this app name:
the parent became `org.example.cvt583.CVT583-Safari-Boundary`, while the embedded
extension was `org.example.cvt583.boundary.Extension`. Fix the generated parent's
two Debug/Release `PRODUCT_BUNDLE_IDENTIFIER` values to
`org.example.cvt583.boundary` before building. Keep the generated extension ID.
The explicit placeholder namespace is synthetic and is not a Palladin release ID.

```sh
xcodebuild \
  -project '/tmp/cvt583-safari-wrapper/CVT583 Safari Boundary/CVT583 Safari Boundary.xcodeproj' \
  -scheme 'CVT583 Safari Boundary' -configuration Debug \
  -derivedDataPath /tmp/cvt583-safari-wrapper-build \
  CODE_SIGNING_ALLOWED=NO build
```

This containing-app build passed locally with Xcode26.4 (17E192), macOS26.4.1
arm64, on2026-09-11 after that generated-project correction. It is unsigned
development packaging, not installed/signed-distribution evidence. The empty
fixture icon set produces a converter warning; no release icon claim is made.

The first actual probe attempt stopped at session creation: Safari26.4
(21624.1.16.11.4) requires Allow remote automation. No extension was installed in
an automation session and no native-channel observation passed. This host-setting
gate was separate from implementing the product adapter. At that point Web
selected only Chromium or Firefox and Extension's Safari branch was null;
the implemented adapter and its current limits are recorded above.
Do not substitute the existing Chromium/Firefox evidence or a custom WKWebView
for installed Safari acceptance. Safari16.4 floor, real Identity/Entry, the full
OS/version/distribution and negative lifecycle/security matrix remain open.

Sources: [Apple webpage messaging](https://developer.apple.com/documentation/safariservices/messaging-between-a-webpage-and-your-safari-web-extension),
[Apple WWDC22 recipient-ID contract](https://developer.apple.com/videos/play/wwdc2022/10099/),
[WebKit Safari26 extension automation](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/),
[W3C WebExtensions Classic WebDriver commands](https://github.com/w3c/webextensions/blob/main/specification/webdriver-classic.bs).

## Disposable CI execution

The separate `Safari shared-unlock boundary` workflow runs this account-free
probe on a standard GitHub-hosted `macos-26` VM. It enables remote automation only
inside that disposable VM, starts a task-owned SafariDriver, then retains the
synthetic fixture and report/failure for seven days. It uses `pull_request`,
read-only repository permission, pinned checkout/upload actions and no secrets;
checkout does not persist Git credentials. It does not run on a personal Mac or
use any existing user profile. No Identity or Member key is involved.

This provides an independent execution path while local Safari setting approval
is pending. A successful job would prove only the probe's observations, not a
product adapter or Safari16.4/full-platform acceptance. See the
[GitHub runner contract](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [macOS26 image contents](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md).


## Observed Safari26.6.2 CI boundary (2026-09-11)

The disposable macOS26.6.2 arm64 runner creates a real Safari26.6.2 session.
Installation returns an object with an `extension` string, rather than a bare
string (run34629126061). The identifier includes a percent-encoded space before
`(UNSIGNED)`. b843f8e decodes the observed object shape and passes installation;
run34629708338 then failed at the first native webpage Port.

Runs34629944077 and34630127432 distinguish that failure: `browser.runtime.connect`
exists; the raw browser-returned identifier disconnects, while the percent-decoded
representation times out. The latter receives no background `connected` message,
so the test does not yet establish a native sender, current document, or profile
boundary. This is not proof that decoding alone fixes routing. Both candidates
come only from browser installation metadata; there is no page-provided expected
identity and no product fallback. Negative cases after this failed positive gate
have not executed. Generic Test CI34629708163 and34629943999 passed separately.

Apple requires webpage access permission for external messaging; a missing grant
is a hypothesis to investigate, not an observed cause. See
[Apple's webpage-messaging explanation](https://developer.apple.com/videos/play/wwdc2022/10099/)
and [Safari permission management](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions).
To observe native permission UI on failure, the CI workflow explicitly enables a
failure screenshot. The flag refuses to run outside a GitHub-hosted Actions VM;
ordinary local invocation never captures the user's desktop. The screenshot is
part of the seven-day synthetic artifact and contains no Identity or vault data.


### Native background and host-permission observations

Run34631153165 (48d6093) tested classic worker, module worker and nonpersistent
background document separately on disposable Safari26.6.2 runners. Each installed
fixture opened its own browser-reported `safari-web-extension://` diagnostics page.
All three returned a ready internal worker listener and the percent-decoded
installation identifier as `browser.runtime.id`. API permissions were present,
but granted `origins` were empty. No external-Port response passed. A previous
run occasionally did not observe the installed page within the setup wait; this
is now an explicit setup failure rather than evidence about external messaging.
The default probe uses a module worker, matching the product manifest.

A subsequent real click on the fixture's `permissions.request` button produced
an explicit Safari error (run34631412243): a port is invalid in its origin match
pattern. 4dcd9e7 uses `http://127.0.0.1/*` for both declaration and request while
retaining exact `http://127.0.0.1:55189` sender assertions and a loopback-only
server. It does not change product host permissions. A grant is accepted only
through the browser's normal permission API; no permission database is edited.
The native request result and any permission UI remain observations to collect.

Run34630327241's failure screenshot showed a macOS Local Network prompt for
Python. The literal loopback fixture now skips HTTPServer's reverse DNS and
system-proxy discovery. The prompt disappeared in run34630632833, while external
messaging still failed. This removes an unrelated test-environment dependency;
it does not prove the cause of the Port failure or grant network privileges.


### First native channel and document passes

The exact native permission helper ran successfully in the disposable CI VM:
it matched the fixture name and127.0.0.1 in Safari's native dialog and clicked
`Allow for One Day`. `permissions.request` then returned true and `getAll`
reported the declared loopback host. No TCC/permission database was modified.
The helper is enabled only by `--ci-grant-fixture-access`, with a GitHub-hosted
runner check. It never runs against a local user's Safari.

Classic worker53461d6 passed6 observations in job103370591169/run34631933105
at18:12:37Z. Module worker0e689d4, matching the product background type, passed9
observations in run34632192940 at18:15:28Z. Native sender/frame0 and a separate
`webNavigation.getFrame` returned equal document IDs; same-URL reload produced
a different matching pair. Browser-owned senderTab/currentTab both reported
incognito=false. The decoded installation ID received messages; raw percent-encoded
ID and a nonexistent recipient disconnected. Unlisted localhost did not reply,
but also lacked host permission, so this is not an isolated proof of the
externally_connectable allowlist. Private-window rejection, complete old-Port
retirement/replay and product MK/Identity/Entry remain untested here.

Both workflows remained failed overall because other background variants did not
expose the diagnostic page during setup. These are individual successful jobs,
not a green full workflow. Waiting for a real fixture URL fixed an early
about:blank navigation assumption; 42b3b89 further opens diagnostics from background
startup rather than depending on the temporary install's onInstalled event.
It reuses an existing fixture tab and does not focus it. Current setup stability
has its own CI run, independent of the recorded9 observations.


The startup correction42b3b89 subsequently passed the complete three-job workflow
34632420779: classic worker9 checks at18:17:49Z, module worker9 at18:17:51Z and
background document9 at18:17:55Z. Each used the exact native one-day grant,
confirmed independent current-document IDs and normal-profile fields, and passed
the stated negative observations. Generic Test CI34632420801 also passed.
This proves the synthetic channel foundation on Safari26.6.2/macOS26.6.2 arm64,
not the product adapter, Identity/MK/Entry, Safari16.4 or full distribution matrix.
