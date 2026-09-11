# Safari recipient and document boundary

The product now contains a separate Safari native-Port adapter. This probe still
tests a synthetic fixture, not product login/unlock. The latest increment removes
global `tabs` permission and checks the lifecycle event APIs and native tab
URL/status required by the adapter. Earlier nine-check results below belong to
the earlier fixture with `tabs`; they do not prove the new permission scope.

Run34634982018 found `webNavigation.onTabReplaced` absent in all three Safari26
background variants. The remaining lifecycle events and host grant were present.
The adapter now treats replacement events as optional and requires fresh native
tab/document lookups before each operation; a removed tab cannot keep its route.
The probe preserves that observation and requires only the events actually used.

CVT-587/CVT-592/CVT-604, within CVT-583. This is a synthetic browser probe and
packaging preparation, not an implemented Safari shared-unlock adapter or
Identity/MK/Entry acceptance.

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
gate is separate from implementing the product adapter. Web currently selects
only Chromium or Firefox; Extension's Safari shared-unlock branch is still null.
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
