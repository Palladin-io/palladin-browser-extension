# Shared unlock platform evidence

CVT-587/CVT-592/CVT-604, part of CVT-583. This note separates synthetic
capability probes, product-channel tests and actual Identity/Entry/lifecycle
tests. Only the latter use synthetic accounts with real browser cryptography
and an isolated Palladin backend. No result here proves the full acceptance
matrix or production support.

## Current acceptance status — 2026-09-11

Safari Identity harness715b076 is implemented with real Web registration,
browser-derived Safari recipient configuration and a random encrypted username
as Entry proof. Each extension assertion reopens a fresh native Popup, so retained
React state cannot pass it. Private Web bundles are temporary and excluded from
retained artifacts; no auth/key injection or CSP changes are used.
The local macOS26.4.1 attempt at19:46:42Z stopped before Identity with
`remote-automation-disabled`. Zero Identity checks passed and local settings
were not changed. Owner approval remains pending. Password autofill, restart,
the full lifecycle/security/distribution matrix and final review remain open.

The shared native Popup helper passed15 account-free checks in Safari
CI34640667500 at19:48:09Z, including real onboarding completion and closing/reopening
the Popup. Ordinary CI34640667407 passed1718 tests/141 files and all three builds.
This validates the native UI mechanism, not the unexecuted Safari Identity flow.

Earlier native Safari run34639004301 (7deb6c9, runtime16ab8ea) passed13
instrumented product-channel/Popup checks at19:29:17Z. It proves that the native
Popup can use the unchanged private-command guard, while a Popup URL in a tab
and a cross-window API call from diagnostics retain tab authority and are rejected.
Earlier runs34637914020/34638324611 failed those mistaken positive assumptions;
the corrected test uses a fixed value-free script in the Popup's own realm.
Ordinary CI34639004324 passed1718 tests/141 files and all three builds.
No Safari Identity/MK/Entry or distribution acceptance is claimed.

Firefox155.0.1 on the current Webc58ec2b/Extension7deb6c9 tree passed16
real Identity/Entry checks at19:29:14Z after sharing the unchanged Python Web
steps with future Safari tests. An earlier run on Extension6b40b7d timed out
after the browser-observed background restart at19:18:40Z, after13 checks.
Its coarse stage did not distinguish the Popup's unlocked display from password
autofill. The two waits now have separate failure stages; runs9673be7 at19:21:45Z
and7deb6c9 at19:29:14Z passed. No runtime fix explains that intermittent failure,
so it remains open. All three use the same Firefox artifact SHA256
`be9cc51f652eb0863163cfd4045270b9a29e4f477d994e44f7e0de98e3c2502a`
and Web Python artifact SHA256
`cd51bfe70b615d42d292a690c01fd29fce7ba98d9bed682ec76248d248a5c6fd`.

The installed product-channel test found a packaging defect: `vite.config.ts`
still replaced Safari's configured environments with an empty array. The
manifest exposed the route while the compiled worker disabled it. Run34636215449
failed before ready; run34636880642 independently confirmed a loaded worker and
valid native document but no ready. Fix16ab8ea removes the Safari-only override.
A build-config regression fails only on Safari before the fix and passes on all
three targets afterwards. The configured Safari build now contains the selected
Web origin. Native product run34637021800 passed10 checks at19:07:35Z on
Safari26.6.2/macOS26.6.2 arm64; all three synthetic variants also passed.
The ordinary Extension CI34637021792 and Webc58ec2b CI34634984109 passed.

The product-channel fixture imports the unchanged compiled worker, adding
a private diagnostic page/wrapper, a fixed Popup sender/status script and
synthetic display name. Its hashes and
instrumentation are explicit. It does not inject sessions or keys, and this
PASS does not prove the real Web/Identity/MK/Entry flow or distribution.

The current implementation increment adds a Safari product adapter. It uses
native external Ports, the decoded configured bundle/team recipient, native
extension URL and sender document ID, and independent `tabs.get`/top-frame
`webNavigation.getFrame` reads bounded to two seconds. Missing lifecycle fields
are not fabricated; supplied non-active/non-top-frame values are rejected.
Top navigation, tab removal/error and configuration changes retire pending as
well as ready connections. Safari26 has no `webNavigation.onTabReplaced` (native
run34634982018); it relies on the required fresh tab/document lookup before each
use. If a platform exposes replacement events, those also retire connections.
Chromium shares only the bounded Port
mechanics and retains its stricter native lifecycle authority.

Configured Safari artifacts add `webNavigation`, exact configured Web host
permissions and `externally_connectable.matches`. They do not add global `tabs`,
native messaging, offscreen, a Chromium identity or a DOM relay. Safari rejects
ports in host patterns, so Safari's local API pattern is normalized to its host;
runtime environment checks retain the exact configured port. The Web's Safari
recipient configuration is empty by default and has no cross-browser fallback.
This code is not yet native product acceptance. The probe now checks required
lifecycle API availability and tab URL/status with host access but without global
`tabs`. Run34634982018 confirmed the missing optional replacement event and a
successful native host grant in all three variants, then stopped at its former
event assertion. The corrected probe d188270 passed10 checks in all three variants in
run34635229213 (classic18:47:47Z, module18:47:43Z, document18:47:31Z), including
exact tab URL/status/current document without global `tabs`. Real product
Identity/MK/Entry tests remain pending.

All completed Identity runs below used macOS26.4.1 arm64 and disposable profiles.
The historical sections retain earlier failures and narrower observations; this
table identifies the latest successful product runs rather than replacing them
with a channel-only probe or a successful build.

| Browser / version | Installation | Identity/Entry/lifecycle | UTC observation |
|---|---|---|---|
| Chrome152.0.7977.84 | Unpacked, browser CDP; headless |16/16 PASS|16:28:18|
| Chromium153.0.8010.12 | Unpacked, load flag; headless |20/20 PASS, current Safari-adapter increment + own activity/full restart|18:48:02|
| Brave1.95.101 / engine153.0.8010.37 | Unpacked, browser CDP; headless |16/16 PASS|16:25:33|
| Edge153.0.4234.32 | Unpacked, browser CDP; headless |17/17 PASS, own activity|17:34:54|
| Firefox140.0 | Temporary product XPI |16/16 PASS, new coordinator|18:01:57|
| Firefox155.0.1 | Temporary product XPI |16/16 PASS, current runtime; earlier restart timeout remains open|19:29:14|
| Opera135.0.5973.133 / engine151.0.7922.176 | Unpacked, browser CDP; headless |16/16 PASS|17:03:15|
| Safari26.6.2 / macOS26.6.2 arm64 | Instrumented product worker/Popup, one-day loopback grant in disposable CI |15 channel/Popup authority/UI checks; Identity/MK/Entry unverified|19:48:09|

The16 baseline checks cover real registration/email/password login, automatic unlock,
live encrypted Entry/password decryption, continued operation after Web closure,
reopened Web, browser-controlled background restart and shared manual lock/logout.
They do not cover all settings, account-isolation, expiry, offline, multi-document,
OS-lock/sleep/resume or distribution cases. Windows/Linux, other required
versions (including the Chromium116 and Safari16.4 floors), the full matrix and
independent final review remain open. Firefox popup DOM activation is not trusted
input evidence. Reproduction and limitations:
[Identity harness](../tests/browser/SHARED-UNLOCK-IDENTITY.md),
[Safari probe](../tests/browser/SHARED-UNLOCK-SAFARI.md).

The combined own-activity/full-browser-restart case passes20 checks on Chromium153.
Current Chromium20 uses clean Webc58ec2b/Extensiond188270 (18:48:02Z).
Edge/Firefox140 runs retain Web1314dec and Extension runtime3444a75;
Firefox155 uses clean Webc58ec2b/Extension7deb6c9 (runtime16ab8ea).
Chrome/Brave/Opera rows retain their earlier runtime810cf86 observations. Edge's CDP development installation does not survive browser
restart, so that distribution path remains unverified. New delayed-authorization
Edge failures are also retained below; earlier successful runs do not erase them.

## Required boundary

The approved target is automatic Web <-> Extension login/unlock in one normal
browser profile without a desktop application or native broker. On 2026-09-10
the product owner accepted the configured exact extension ID/origin authenticated
by the trusted browser as the recipient boundary. A peer's self-reported ID,
package metadata or pairing marker is never its own authority.

This supersedes the earlier requirement to distinguish an official installation
from a manually substituted extension with the same ID or a complete copied
profile. Those cases are client compromise outside this feature's protection;
a same-ID substitute can receive MK under this accepted boundary. Ordinary
separate profiles are not automatically linked. No store attestation or original
profile attestation is required. This decision does not enable Agent Inject.

The lifecycle correction permits a fresh authenticated handoff from a still-valid
unlocked peer after a worker restart, and independent operation after the source
Web tab closes. Account/environment isolation, browser document/generation checks,
current Identity authorization, RAM-only keys, encrypted one-time handoff, durable
lock/logout/off/revoke and original session limits remain mandatory. The probe
below implements none of those runtime handoffs.

## Reproduce the Chromium observations

```sh
npm ci
npx playwright install chromium
npm run test:browser:shared-unlock-platform
```

The harness creates two synthetic unpacked fixtures with different worker bytes
and one generated public manifest key. The corresponding private key is neither
used nor saved. Both fixtures declare the same synthetic HTTPS origin. Playwright
serves that origin locally through routing; no Palladin service is contacted.
Each fixture runs in a fresh temporary browser profile. A third run uses a copy
of the first synthetic profile after the first browser has closed.

The assertions check:

1. Different worker bytes have the same browser-assigned extension ID.
2. The Web page observes the same response and the same browser-authored
   extension-frame origin from both fixtures.
3. The unpacked worker can report `installType: normal` to the Web page while
   the harness observes `development` directly through `management.getSelf()`.
   The Web page has no direct `management` API. This does not imply the browser's
   actual `getSelf()` result is false; the peer-supplied response is not authority.
4. The allowed HTTPS top frame reaches the worker with browser-authored origin,
   frame, tab and document context. This is useful authority for Web sender
   routing, distinct from proof of the extension recipient's package.
5. An unlisted HTTPS origin cannot send an external message to the fixture.
6. The copied synthetic profile retains the extension ID and a non-secret
   local-storage marker.
7. The copied profile does not restore the worker's volatile marker.

`test-results/shared-unlock-platform-probe/report.json` records the actual browser
version, OS/architecture, time, observations and fixture hashes. The exact fixture
files are retained beside it; the temporary browser profiles are deleted. All
artifacts are ignored by Git. A failed run removes the previous report before
testing, so a stale successful result cannot be mistaken for the current run.

Both fixtures are unpacked and synthetic. Neither is described as an official
store-installed Palladin artifact. These observations show that the tested signals do not attest package bytes
or distinguish a copied profile. The accepted browser-identity boundary above
does not claim either property. The probe does not attest a production artifact
or verify a real MK handoff.

## Independent authority assessment

| Candidate | Evidence and limit | CVT-587 status |
|---|---|---|
| Extension ID or extension-frame origin | The Chrome manifest `key` deliberately preserves the same ID for development. The probe observes different bytes under the same ID/origin. | Not package/profile attestation; browser-confirmed exact ID/origin is accepted within the stated client-compromise boundary. |
| Peer-reported `management.getSelf()` | Browser metadata is available inside the extension; a relayed response is candidate-controlled. | Never authority for the peer; not required by the accepted boundary. |
| Saved local pairing marker | The synthetic profile copy preserves the marker. | Correlation/revocation metadata only; cannot authorize a handoff. |
| Browser-authored Web sender context | The probe observes allowed origin/top-frame/document context and rejects an unlisted origin. | Useful Web sender boundary; does not attest recipient package/profile. |
| Chrome enterprise platform-key attestation | Official API is ChromeOS-only and policy-restricted. | Does not cover the required ordinary desktop browser matrix. |
| Safari webpage messaging | Apple documents addressing by extension bundle ID and team ID. The real Safari route, document binding and lifecycle still require installed-artifact tests. | Not yet verified; not inferred from Chromium. |
| Firefox webpage messaging | No Web-page `runtime.connect`/`sendMessage`; the implemented extension-resource/private-Port adapter has actual140/155 Identity/Entry observations below. | Partial browser evidence; full version/OS/distribution and negative lifecycle acceptance remain open. No original-profile attestation required. |

Sources checked 2026-09-10:

- [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Chrome management API](https://developer.chrome.com/docs/extensions/reference/api/management)
- [Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome enterprise platform keys](https://developer.chrome.com/docs/extensions/reference/api/enterprise/platformKeys)
- [Mozilla externally connectable](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable)
- [Apple webpage-extension messaging](https://developer.apple.com/documentation/safariservices/messaging-between-a-webpage-and-your-safari-web-extension)

## Acceptance remains open

Chrome, Chromium, Brave, Edge, Opera, Firefox and Safari remain in the required
matrix. A Chromium probe is not evidence for branded browsers, another OS,
Firefox or Safari. No row has a verified complete shared-unlock adapter from this
work. A successful probe command means its limited assertions passed; it does
not satisfy CVT-587, CVT-604 or the parent goal.

Implementation may proceed under the accepted browser-identity boundary. Each
adapter must obtain actual browser authority for its exact configured route and
must verify the source/recipient generations, account/environment, one-time
Identity operation and current link/limits. A stable marker or a peer's payload
cannot replace those checks. Actual handoff, Identity bootstrap, cancellation,
lifecycle and settings require the remaining acceptance cases; the current-status
table records completed product runs. Full browser/OS artifact testing remains open.

## Firefox manifest-resource candidate - 2026-09-11

A new **research probe**, not an approved runtime adapter, tests whether the Web
can relate a Firefox-generated resource origin to the configured Gecko ID by
fetching the canonical `/manifest.json` directly from that `moz-extension:` origin.
Candidate URLs/claimed IDs and `runtime.getManifest()` relayed by the peer are
not authority. The tested Web fixes the resource path itself, uses no cookies,
rejects redirects and compares the retrieved Gecko ID with an independent fixed
expected ID; it also records the browser-authored origin/source of an extension
iframe. This Firefox probe does not change product manifest permissions or enable a Firefox route.

Run with Python 3 (standard library only), an official Firefox binary and a
matching Mozilla geckodriver supplied explicitly:

```sh
npm run test:browser:shared-unlock-firefox-boundary -- \
  --firefox /path/to/firefox --geckodriver /path/to/geckodriver
```

The command starts its own localhost WebDriver and disposable headless profile,
installs two synthetic temporary add-ons, and cleans up the browser/driver. It
never connects to Palladin or opens a user's existing browser profile. Fixtures,
hashes, observations and browser/driver/platform versions are recorded under
ignored `test-results/shared-unlock-firefox-boundary/`. A new run first removes
the previous success report; assertions must pass before a new report is written.

The other add-on claims the expected ID and supplies a URL to a fake manifest.
The Web instead fetches the canonical root manifest, sees the browser-installed
other ID and rejects it. Both add-ons attempt webRequest/DNR interception of their
own manifest; a second direct fetch checks the result after those attempts. An
extension-page service-worker attempt and an unlisted Web origin are also checked.
These narrow cases do not prove every possible resource substitution or package
loading edge case.

The first local observation used **Firefox 155.0.1 / geckodriver 0.37.1 on macOS
arm64**, with Mozilla's archive SHA-512 and the app's Apple Developer ID signature
verified before execution. The standalone pre-harness observation accepted the
expected-ID add-on and rejected the wrong-ID add-on; both interception APIs
registered but observed no manifest request, and the extension page had no
service-worker API. The checked-in harness adds wrong-resource and unlisted-origin
assertions; the final checked-in harness also passed both IDs, wrong-resource,
interception and unlisted-origin checks on that same browser/OS. The ignored
report records the exact fixture hashes and versions; no runtime gate is enabled.

**Open security question:** establish that the browser's install-time ID and the
canonical resource manifest cannot diverge through supported extension mechanisms
in every supported Firefox version/distribution. Direct resource loading is a
candidate independent browser boundary, not an assumption that package metadata
is trustworthy. Unpacked filesystem tampering, alias/duplicate manifest parsing,
packaged-resource resolution and lifecycle changes require explicit assessment.
No MK, backend session, production allow-list, trust-contract change or Firefox
feature acceptance follows from this probe. The accepted no-native-broker scope
and same-ID/profile-compromise exclusion remain unchanged.

Primary references checked for this candidate:

- [Mozilla web-accessible resources](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources): browser resource schemes, per-instance UUIDs and explicit resource exposure.
- [Mozilla browser-specific settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings): Gecko ID in the extension manifest.
- [Firefox ExtensionProtocolHandler](https://github.com/mozilla-firefox/firefox/blob/88fa72d2f463129e64c2eb5c5227ef20b5c08574/netwerk/protocol/res/ExtensionProtocolHandler.cpp): browser-side extension resource resolution; inference about this candidate still needs installed-artifact proof.
- [Firefox WebRequest](https://github.com/mozilla-firefox/firefox/blob/88fa72d2f463129e64c2eb5c5227ef20b5c08574/toolkit/components/extensions/webrequest/WebRequest.sys.mjs): request interception implementation; does not by itself prove the absence of every alternate modification path.

### Alias, duplicate and removal checks

The expanded probe passed **10 installed fixture cases** on Firefox155.0.1 /
geckodriver0.37.1 / macOS arm64 at2026-09-11T13:31:05Z. In addition to the original
two cases, it tests both orderings of conflicting `applications` versus
`browser_specific_settings`, duplicate settings properties, duplicate `id`
properties, and duplicate `manifest.json` ZIP entries. For every accepted package,
the canonical resource ID equals the independently observed browser install ID.
An other-ID installation is never accepted merely because another property or
ZIP entry claims the expected ID. A package actually installed under the expected
ID remains within the approved same-ID boundary. All10 canonical resource fetches
were denied after uninstall, including from the originally allowed Web origin.
The existing frame/source, interception and unlisted-origin assertions run for
each case. The report records per-case installation results and all fixture hashes.

The actual app's `application.ini` identifies source revision
`5fdfd0092780e85643e2cddc0e1b590c8b9ef860`, BuildID20260903215306; codesign identifies
Mozilla Corporation. Source inspection at that revision corroborates these narrow
observations: [Extension.sys.mjs](https://hg.mozilla.org/releases/mozilla-release/file/5fdfd0092780e85643e2cddc0e1b590c8b9ef860/toolkit/components/extensions/Extension.sys.mjs)
reads root manifest JSON and prefers the Gecko settings used by the probe;
[XPIInstall.sys.mjs](https://hg.mozilla.org/releases/mozilla-release/file/5fdfd0092780e85643e2cddc0e1b590c8b9ef860/toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs)
derives the manifest ID and passes it into signature verification, whose
certificate-name mismatch fails verification. This is source inspection, not
a signed-distribution test or an independent review verdict.

Those synthetic results alone did not enable an adapter. The subsequent product
adapter and limited channel/CSP proof are recorded below. BFCache/update/disable-enable,
Identity/MK/Entry handoff, the supported Firefox version/OS/distribution matrix and
independent security review remain open. The other browsers remain required. Actual local Chromium Identity/Entry
testing is documented separately in
[`tests/browser/SHARED-UNLOCK-IDENTITY.md`](../tests/browser/SHARED-UNLOCK-IDENTITY.md).


## Actual Chromium product channel - 2026-09-11

The configured Chromium worker now receives `palladin.shared-unlock.browser.v1`
external Ports. It accepts only the configured exact Web/API pair, a normal-profile
active top-level Web sender and browser-authored tab/document identity. It rejects
extension/native senders and checks the **current** frame using
`webNavigation.getFrame({tabId, frameId: 0})`, including lifecycle and exact origin
with its port. Sender lifecycle alone is a creation-time snapshot, not current
authority. Navigation, replacement, removal, disconnect and server changes retire
a route permanently. Pending initialization/read results cannot revive it.

Public `VITE_SHARED_UNLOCK_ENVIRONMENTS` is an explicit JSON array of
`{"apiUrl":"https://api.example.test","webOrigin":"https://app.example.test"}`
pairs. Blank configuration disables the route. No hosted pairing default is added.
Configuration belongs in ignored `.env.local` or deployment input. Each API and
Web origin occurs once, at most 16 pairs; Web paths/wildcards are rejected. Only a
configured Chromium artifact adds `manifest.chromium.shared-unlock.json`:
`webNavigation` and exact-host `externally_connectable` with `ids: []`. Manifest
patterns intentionally route by host; the worker independently enforces the exact
port and configured API. Build validation compares the artifact to explicit build
configuration and rejects extra origins/extension IDs or unexpected permission.
Firefox uses its own configured private-frame route described below; Safari does
not receive this external route or navigation permission.

The permission is needed to distinguish successive documents in the same tab and
retire routes at navigation start. Handlers act only on bound tab IDs, with
transient memory state; no navigation history is stored, logged or analyzed.
This permission change still requires the ordinary component PR security review.

The first implementation exchanges only strict `hello`/`ready` frames. Web nonce
and channel ID correlate this connection; **neither replaces a crypto-session or
source-authorization generation**. There are no account claims, tokens or keys in
these frames. The channel does not yet call source/receiver crypto coordinators.
Up to 64 pending/live connections and a 5-second handshake deadline bound its
memory; local teardown removes listeners even when local `Port.disconnect()`
does not emit `onDisconnect`. Server mutations synchronously suspend admission
and retire pending/live routes, including when overlapping mutations occur.

```sh
npm run test:browser:shared-unlock-chromium-channel
```

This builds the actual product Chromium artifact, with explicit ephemeral loopback
Web configuration, local API selection and analytics disabled, then loads its
unchanged bytes into a disposable Playwright Chromium profile. It starts no API
server and performs no login. The test checks browser-derived extension ID and
current document binding; same-document history; new document/channel after reload;
replacement of the old Port in the same document; wrong-port and unlisted-origin
rejection; rejection of a same-origin iframe without affecting the top frame;
expanded/repeated framing and attempted API switching. It removes its previous
report first and writes a new report only after all assertions pass. Temporary
profiles and local servers are cleaned up. The repository test workflow also runs
this command after unit/build checks on its Linux runner and retains the report
for seven days; it uses no secrets or user profile. Artifact file hashes, browser version,
OS/architecture and timestamp are in ignored
`test-results/shared-unlock-chromium-channel/report.json`.

**Nine checks PASS on Chromium 153.0.8010.12 / macOS arm64.** This is an actual
configured product channel with a synthetic page, not the application Web adapter,
Identity/MK handoff, a store-distributed artifact, the Chrome 116 floor or the full
supported browser/OS matrix. Those acceptance gates remain open.

Primary browser contracts used:

- [Chrome Runtime MessageSender and Port](https://developer.chrome.com/docs/extensions/reference/api/runtime)
- [Chrome Web Navigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)
- [Chrome externally connectable](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)


### Optional paired Web application check

`npm run test:browser:shared-unlock-chromium-channel -- --web-source /path/to/web-repository`
also builds the specified Web checkout with explicit synthetic local configuration
and the real extension ID. After the standalone cases it serves that unchanged
Web build under its generated `_headers` and verifies application bootstrap and
reload against the actual extension. A value-free test observer wraps the native
connect call, preserving its browser implementation and exact recipient; product
bytes are not patched. All external page requests are blocked, no user account
is used, and Web file hashes are retained beside the extension report.

**Eleven checks PASS on Chromium 153.0.8010.12/macOS arm64**, including both real
application bootstrap and new-document reload under delivered CSP. The report marks
whether the optional real Web mode ran. Ordinary fork-safe CI uses standalone
mode and does not clone or require a private Web repository. This paired probe
still transfers no MK and proves no Identity/session/shared-lifecycle acceptance.

## Firefox product adapter and delivered CSP — 2026-09-11

The Firefox build now composes the existing encrypted handoff/own Identity
coordinator through a separate browser adapter. With explicit
`VITE_SHARED_UNLOCK_ENVIRONMENTS`, it adds `webNavigation`, exact configured host
patterns for a discovery content script, and Web-accessible canonical
`manifest.json` plus `src/shared-unlock-bridge/index.html`. Without configuration,
these capabilities and the bridge artifact are absent. Safari remains unchanged.
CRXJS generates the one canonical manifest first; a final bundle hook adds its
self-reference. No copied manifest or relayed `runtime.getManifest()` is authority.
Generated route validation compares permissions and critical resource matches
against independent build input and rejects wildcard/second routes.

The own extension iframe forwards strict bounded protocol frames only from the
exact configured Web origin in its direct top parent. Its private runtime Port
is accepted only with the browser's own extension ID/origin/exact URL, normal
profile tab and bridge document. The worker compares `getAllFrames` results for
the top Web document and bridge, including `parentFrameId` and `parentDocumentId`;
page-supplied document IDs are never used as expected values. Checks accept
Firefox's safe-integer frame IDs above 32 bits. Missing document authority fails
closed. Both documents are rechecked before dispatch and at sensitive coordinator
boundaries. Their navigation, tab removal/replacement, Port loss or server change
retires ready and pending routes. Queue/deadline limits match the Chromium route.
Only framing is shared with Chromium; its browser-specific checks remain intact.

Web uses its explicitly configured Gecko ID in the route and all account/link
scopes. UA selects the adapter only; it cannot authenticate an ID. The Web adapter
independently fetches the exact canonical browser resource, rejects redirects,
other IDs and supplied paths, and pins native iframe origin/source. It rechecks
resource identity on inbound frames and sensitive awaits. Keys and plaintext
Identity tokens never enter the iframe. Web's generated CSP enables
`moz-extension:` for resource fetch/frames only when a valid Firefox ID is supplied;
script-src receives no extension scheme. Removal/reinsertion, src restoration,
reload, resource failure and pagehide permanently retire the old route.

Run against explicitly configured built artifacts with Python standard library,
Firefox and geckodriver in a fresh disposable profile:

```sh
python3 tests/browser/shared-unlock-firefox-channel.py \
  --firefox /path/to/firefox --geckodriver /path/to/geckodriver \
  --web-origin http://127.0.0.1:5173 --api-url http://localhost:55083 \
  --web-source /path/to/web-repository
```

`--web-source` serves the actual Web `dist` and its generated security headers;
it observes public ready metadata after removing the first bridge and letting
the real lifecycle reconnect. It does not replace the provider, install keys or
set auth state. Without this option, a synthetic CSP page exercises the real
extension's hello/ready and repeated-hello rejection. Results and artifact hashes
are written only under ignored `test-results/shared-unlock-firefox-channel/`.

Both modes passed locally on **Firefox 155.0.1 / geckodriver 0.37.1 / macOS 26.4.1
arm64**, using a temporary installation of the built product XPI. This proves
limited real browser transport and delivered Web CSP, not a completed Firefox
Identity/MK/Entry flow, signed distribution, Firefox 140 floor, all OS versions,
BFCache/update/disable-enable matrix or independent security approval. Those
remain release gates. The earlier ten-case synthetic manifest identity probe now
also records browser-owned sender and top/bridge/parent document identities.

**Known compatibility gap:** Mozilla's [browser compatibility data for
`webNavigation.getAllFrames`](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/webNavigation.json)
records both `documentId` and `parentDocumentId` as added in Firefox **153**.
The native-document-ID adapter must reject absent authority. The extension's
general 140 floor is unchanged. The separate legacy implementation and its
remaining real-browser gates are recorded below; dropping native checks or
raising the product floor does not satisfy the existing acceptance criteria.

## Firefox real Identity/Entry and background restart — 2026-09-11

The new [native Firefox Identity harness](../tests/browser/SHARED-UNLOCK-IDENTITY.md#firefox-identity-entry-and-background-restart)
passed **16 checks at 14:53:07Z** on Firefox 155.0.1 / geckodriver 0.37.1 /
macOS 26.4.1 arm64, temporary product XPI. Actual artifacts: Web head `ceaedeb`
and Extension head `e0a0492` (runtime `4568b63` / `3694ec9`), isolated backend
main `117c84d6`. The ignored report records complete artifact hashes.

It registers an account using browser crypto/recovery confirmation, receives
and verifies the real email token through a RAM-only SES delivery fixture,
logs in with the real password, and observes automatic Extension unlock. After
an authoritative empty Extension snapshot, Web creates an encrypted Credential;
the still-unlocked Extension receives the live invalidation and decrypts its
password for actual automatic exact-host fill. It repeats password proof after
fresh manual unlock, after Web closure and after a browser-controlled background
stop/start. Reopened Web automatically unlocks from Extension. Manual lock works
in both directions; Extension logout also logs Web out.

The restart uses Firefox's own DevTools termination operation, requires observed
running→stopped→running states and leaves Web alive. It does not mutate product
state. Native popup DOM activation preserves the real sender but is not evidence
of trusted input/idle renewal. The login page is a controlled BiDi HTTPS response
with only its declared optional exact-host permission granted by the browser;
TLS handshake and the permission-prompt UX are outside this proof. Actual Web
CSP and all product guards remain enforced. No clipboard, screenshots, key/auth
injection or Identity response replacement; secret comparisons return booleans.

This extends the earlier channel proof to real Identity/MK/Entry and controlled
background restart, not whole-browser shutdown. Firefox 140–152 compatibility,
all OS/distribution/lifecycle variants, other platforms, expiry/tokenless/resume/
key-use/mismatch and final review remain open. No full-matrix acceptance is claimed.

## Firefox 140 document-marker candidate — 2026-09-11

`tests/browser/shared-unlock-firefox-legacy-document.py` is a separate synthetic
probe, with no Palladin account, keys, handoff or product adapter. Run with explicit
`--firefox /path/to/firefox --geckodriver /path/to/geckodriver`; it accepts versions
140–152 only, installs its temporary XPI from a retained file, owns a disposable
profile and writes value-free evidence under ignored
`test-results/shared-unlock-firefox-legacy-document/`.

On Firefox **140.0 / geckodriver 0.37.1 / macOS 26.4.1 arm64**, seven observations
passed. A browser-directed `tabs.sendMessage` to the current extension iframe
returns its own RAM marker. Reloading that iframe at the same URL retains its
frameId but changes its marker, so the previous marker no longer matches the
current browser response. `scripting.executeScript` in the top document's
ISOLATED world reads an extension-created RAM marker: child reload preserves it,
top reload changes it, and setting the same global property in the page world
does not replace it. Browser sender/frame parent/URL checks also run. Native
document IDs are unavailable, confirming the current product adapter's gap.

The earlier `runtime.getContexts` candidate does **not** cover this iframe:
the API is unavailable in the unprivileged Web-accessible frame and the background
query does not enumerate it. Mozilla's [Firefox 140 ExtensionParent source](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_140_0_RELEASE/toolkit/components/extensions/ExtensionParent.sys.mjs)
likewise leaves ContentScriptContextParent without a toExtensionContext mapping.
Do not use a claimed context ID as authority for this route.

The installed 140.0 archive was checked against Mozilla's published SHA512SUMS
and its code signature verified (Mozilla team 43AQ936H96), BuildID20250616215311,
source687d5aa108e077ad34dae793afa0c698c5767e30. These marker observations only
establish a candidate primitive. The probe deliberately exposes synthetic
observations to its test page; production document markers must stay private.
No production fallback is added or approved here. Navigation during asynchronous
reads, stale messages/Ports, removal, BFCache, lifecycle, handshake/pre-key-use
binding, actual 140 Identity/MK/Entry and independent security review remain
required before this can replace missing document IDs. The product still fails
closed on 140–152.

## Legacy Firefox route implementation — 2026-09-11

The extension now has a separate 140–152 route, selected only with Firefox's own
`runtime.getBrowserInfo` result and absent native document IDs. A modern Firefox
with missing document authority cannot take this route. The 153+ native-ID path
retains all of its checks.

The real own bridge sends its boot UUID on the private Port before hello. It
never forwards that UUID to Web. The worker independently addresses the current
bridge frame through `tabs.sendMessage` and compares the returned marker with
the Port's initial value. A separate `scripting.executeScript` in top frame 0's
ISOLATED world reads a document marker created by the extension's discovery
script. Browser-owned sender ID/origin/URL/tab/frame and current direct-parent
topology, exact Web origin/port and current API remain required. The top marker
is cleared on pagehide and renewed on BFCache restoration. Public documentBinding
contains only the tab, a legacy tag and random channel ID, never these markers.

Acceptance and every current-document verification compare both private markers
against fresh browser reads. Loading/discarded/frozen/incognito/pending tabs are
denied. Browser reads have a two-second timer plus elapsed wall/monotonic checks;
expired or failed reads close the route. Navigation/commit/error/tab loss retires
pending as well as ready connections, so replies completed after retirement
cannot install a route or dispatch a protocol operation. Bridge pagehide, Port
loss or transport closure also removes the private marker responder.

The initial real Firefox140.0/macOS arm64 Identity run passed registration,
email verification, manual password login, automatic Extension unlock, empty
Extension snapshot and Web Entry creation. It did **not** pass the full
Identity/Entry/lifecycle scenario. The existing inline autofill code separately
requires native sender.documentId, unavailable on 140; full actual password
autofill and subsequent restart/close/reopen/lock/logout must still pass.
This existing autofill compatibility gate must be addressed without removing its
document/origin checks or treating MemberIndex display as password decryption.
The legacy route is an implementation under review, not acceptance of the
140–152 platform matrix. All other release and independent-review gates remain.

On the new working-tree runtime build, Firefox155.0.1 again passed all16 native
Identity/Entry/password/background-restart checks at15:22:41Z. The repeated140.0
run at15:21:45Z pinpoints `live-entry-password-autofill`: native Popup remains
unlocked and shows the created Entry, but password fill times out. The ignored
versioned report/failure files preserve both outcomes and their artifact hashes.

Final configured rebuild at Extension62109a7/Webb47aff9 again passed16 checks on
Firefox155 at15:29:26Z. The report's Extension dirty flag reflects the generated
Python `tests/browser/__pycache__/` directory observed by git status, not a runtime
source edit; that disposable directory is now ignored. Extension CI34616058282
on62109a7 passed **1593 tests /135 files** and the repository's build/browser
checks. The140 password/lifecycle gate is unchanged.

## Firefox 140–152 private fill transport — implementation in validation

The compatibility implementation adds a separate isolated-document Port for
User Credential/card fill. It is not the page relay, `CONTENT_PORT`, capture or
Agent Inject transport. Admission requires browser-owned Firefox 140–152,
absent native document ID, own extension ID, exact HTTPS origin, top frame and
normal-profile tab. Firefox 153+ retains native document addressing.

The worker independently probes the browser's current top frame without a
secret and compares its isolated document nonce with the original private Port
registration. Only that original Port carries the fill payload. A replacement
document cannot receive a password between the probe and delivery. Navigation,
tab loss, Port loss and pagehide retire registrations; BFCache restore and worker
restart require fresh admission and a fresh private route ID. Reads and results
expire after two seconds; the content consumer rejects expired/future messages,
checks the document again and wipes received field references after its DOM
operation. Existing exact-host, form-target and no-overwrite checks still apply.

Legacy Vault fill captures the own key installation/API before decrypting and
checks that same session after decryption and immediately after the final browser
read. A lock, expiry or changed key installation prevents secret delivery.
Focused tests cover these independent browser/message/session boundaries,
including stale Port delivery after BFCache restoration and session replacement
during a browser read. Three configured target builds pass. The first native
run stopped at email verification before reaching fill; the isolated repeat on
Firefox140.0/geckodriver0.37.1/macOS26.4.1 arm64 passed **all16 checks at15:58:29Z**,
including actual password fill and background restart. This is a working-tree
runtime observation (artifact SHA256
`285735aa7e3cc9e6d40609edc77424ecb84edb359575250bc776c073c797288e`),
with the unchanged Web artifact recorded in the versioned report. It remains a
temporary-XPI partial pass, not the full version/OS/distribution acceptance.
Full local validation passes **1625 tests /138 files** with two workers, without
changing timeouts. The initial default eleven-worker run overlapped a native
browser test and failed39 tests, predominantly on timeouts; it is not a pass.
Runtime commit810cf86 has **CI34619584185 PASS**. The same Firefox artifact
again passed16/16 checks on155.0.1 at16:02:22Z. Chromium153/macOS arm64 passed
16/16 Identity/Entry/worker-restart checks at16:03:03Z, including the1500ms
manual-authorization delay. Independent review and the full acceptance matrix
remain open. These local artifacts are not signed-distribution evidence.

## Chrome and Brave actual Identity/Entry observations — 2026-09-11

The Identity harness now accepts an explicit browser executable and label,
records its executable SHA256 and actual engine version, and retains separate
versioned reports. These runs use fresh temporary profiles and the same
configured product artifacts as the preceding Chromium run. Browser labels are
operator-supplied metadata; independently verified vendor signatures and the
recorded executable hashes identify the actual browser binaries.

| Browser | Engine | macOS / architecture | Mode / extension installation | Actual checks |
|---|---|---|---|---|
| Google Chrome152.0.7977.84 |152.0.7977.84|26.4.1 / arm64|headless / unpacked via browser CDP|16 PASS16:28:18Z|
| Brave1.95.101|153.0.8010.37|26.4.1 / arm64|headless / unpacked via browser CDP|16 PASS16:25:33Z|
| Playwright Chromium|153.0.8010.12|26.4.1 / arm64|headless / unpacked via load flag|16 PASS16:24:12Z|

Chrome is a task-owned copy of the installed Google-signed application
(TeamEQHXZ8M8AV). Brave came from the official
[v1.95.101 release](https://github.com/brave/brave-browser/releases/tag/v1.95.101);
its DMG SHA256 matches the release asset digest
`2deaed060d24f0809bb87332a4d75c7dd140bd38d0915b9e63791917eee3898f`.
Both copied bundles passed strict deep codesign verification, Brave with
TeamKL8N8XSYF4. Extended filesystem attributes were removed only from task-owned
copies before verification; signed application bytes were not edited.
Ignored `browser-verification.<label>.json` receipts retain signature identity,
executable hash and observed bundle version.

Each passing run includes real registration/verification/password login,
automatic Extension unlock, live encrypted Entry update and actual password
decryption, Web close/reopen, observed worker stop/start, fresh unlock/decryption
and shared manual lock/logout. The1500ms manual-authorization delay is enabled.
Chrome's explicit development installation uses browser-owned
`Extensions.loadUnpacked`; no storage/key injection, Identity substitution or
CSP relaxation is used. This does not prove store installation, full browser
shutdown, OS-lock/sleep/resume, idle renewal, other versions or operating systems.

Failures are retained separately: a Chromium run reached15 checks but did not
observe final logout; the old pointer helper did not confirm delivery of that
click. The helper now requires an actual trusted click on the exact button and
does not replay an observed click. Passing Chrome, Chromium and Brave repeats each
record one delivered Sign out click; this is stronger interaction evidence,
not a claim that the earlier failure's root cause was conclusively reproduced.
Another Chromium attempt and the first Brave attempt typed into the transient
SPA login form before `logoutAndReload` replaced the document. The harness now
waits for the real final document before entering credentials. A second Brave
attempt timed out launching the browser, before any Identity check; its process
was confirmed terminal before the successful fresh-profile repeat.

The full browser/version/OS/distribution and negative security/lifecycle matrix
remains open, including Safari. The later Edge/Opera runs are recorded below.
Product runtime is unchanged by
these harness improvements; reports identify the working-tree harness state.

The shared native-popup helper also passes the credential-capture regression:24 encrypted writes and the synthetic plaintext/key storage inspection. Documentation, Node syntax and diff checks pass. Earlier runtime810cf86 and docs d7309d3 CI are green; the new harness commit has its own CI gate.

## Edge and Opera actual Identity/Entry observations — 2026-09-11

Edge153.0.4234.32 passed16 checks at16:59:14Z; Opera135.0.5973.133
(engine151.0.7922.176) passed16 checks at17:03:15Z. Both used macOS26.4.1
arm64, headless disposable profiles, the actual unpacked product artifact and
browser-owned CDP installation. Each final Sign out had one observed trusted
click. The1500ms manual-authorization delay was enabled. No product changes were
needed for either browser. The limitations in the current-status table apply.

Edge came from the [Microsoft enterprise feed](https://edgeupdates.microsoft.com/api/products?view=enterprise).
Its package hash matched the feed, and pkgutil verified Microsoft's installer
signature and notarization. The application was extracted locally with
`pkgutil --expand-full`; installer scripts were not executed. Strict deep
codesign verification passed with Microsoft TeamUBF8T346G9.

Opera came from the official [135.0.5973.133 macOS archive](https://get.geo.opera.com/pub/opera/desktop/135.0.5973.133/mac/),
using the arm64 autoupdate archive and its published SHA256. The extracted
application passed strict deep codesign verification with Opera TeamA2P9LX4JPN.
Ignored browser-verification receipts record both downloads, signing identities,
bundle versions and executable hashes. No system browser installation was replaced.

Versioned reports are `report.edge-153.0.4234.32.json` and
`report.opera-151.0.7922.176.json` under the ignored Identity result directory.
Both identify Webb47aff9/Extensionfe58fca, runtime810cf86, and identical artifact
hashes. Opera's dirty-tree flag records documentation edits only; harness and
runtime bytes were unchanged. Extensionfe58fca CI34624193092 passed. Neither
the browser results nor CI complete CVT-583 or authorize release by themselves.

## Full browser closure and installation persistence — 2026-09-11

The optional `--full-browser-restart` Identity case closes the browser while
both clients are unlocked, confirms disconnection and reopens the same profile
with unchanged launch arguments. It requires the exact native worker target,
both locked clients and six actual Entry reveal denials (`code: locked`, no
payload) over three seconds. One ordinary Web password unlock must then restore
the peer's actual Entry decryption. No lock/logout, storage edit, key injection or
second CDP installation command is used. This is graceful closure, not crash or
OS-lock/sleep acceptance. Scenario-suffixed reports preserve the original16 checks.

Chromium153.0.8010.12/macOS26.4.1 arm64/headless/load flag passed19 checks on the
unchanged runtime810cf86/Webb47aff9 artifacts. This run does not add an artificial
authorization delay; that independent stress case remains in the original suite.
Its report is `report.chromium-153.0.8010.12.full-browser-restart.json`.

Edge153's full-profile attempts reached15 checks but did not find the worker
after restart. The browser accepted `ServiceWorker.startWorker`, but native
`Target.getTargets` still had no exact worker. An independent account-free
installation probe at17:12:41Z confirmed `Extensions.getExtensions` reported the
enabled unpacked artifact initially and no such artifact after reopening the same
profile. The closed profile retained extension metadata at location4; no values
from product storage were read or edited. This is a development-installation
limitation, not a passed Edge full-browser restart. A persisted installation path
still needs its own actual test.

Two other Edge attempts stopped earlier after8 checks, during the1500ms delayed
manual authorization. One recorded authorization200 and activation200 while the
extension stayed locked; its route continued after1502ms. The cause is not yet
established. These failures remain open and are retained separately; no runtime
timeout, assertion or cancellation boundary was weakened to obtain a pass.

## Own source notifications and interrupted preparation — 2026-09-11

Paired coordinator tests reproduce a separate deterministic failure: notifying
own authority cancels an active source, but an unchanged account/key generation
caused the subsequent state read to return without advertising a fresh selection.
The consumed attempt could not resume. Both Web and Extension now force a fresh
state/attempt after that cancellation. They still reject late work from the old
attempt and do not create a source if the new authoritative state is locked,
signed out or unavailable. Receiver publication and its single completion callback
retain their existing fences. No crypto format, API or session limit changed.

The new preparation regressions failed on both old coordinators before the fix.
Each repository's21 coordinator cases now cover both directions, interrupted
crypto creation, fresh attempt IDs, single handoff/completion and negative states.
The optional native own-activity scenario also completed17 Edge checks on a new
build, but both baseline comparisons subsequently completed17 checks too. Native
HTTP response timing does not by itself prove when the client applied a renewal.
Consequently this fix is not presented as conclusive resolution of the earlier
intermittent Edge failure; the original reports and that investigation remain open.


## New coordinator: committed native repeats — 2026-09-11

Web1314dec and Extension runtime3444a75 passed Edge17 checks at17:34:54Z and
Chromium20 at17:36:10Z, including real own activity during source preparation;
Chromium additionally covers full browser closure as described above. The clean
source heads and configured artifacts are recorded in scenario-suffixed reports.
Full local suites passed Web2004/278 and Extension1635/138, with lint/typecheck
and configured builds; CI34628446380 and34629126016 passed.

The same runtime was repeated on Firefox140.0 at18:01:57Z and Firefox155.0.1
at18:02:48Z:16 actual Identity/Entry/password/lifecycle checks each passed.
Both report clean Web1314dec/Extension62fc2ef (later extension commits change only
Safari synthetic tests/docs/CI), macOS26.4.1 arm64 and geckodriver0.37.1.
Firefox artifact SHA256 is c34f20d76664ce7bb04d9a82c392dd6a792a37eb8389268fa6317028119f689c;
its harness's Web digest is d12431e74b2251f7ce04eb1339e7365e50e249fa68eb65bcc821616f670487aa.
The Python and Node harnesses use different file ordering when hashing directories;
compare hashes within the corresponding harness, not across their algorithms.
Earlier runtime810cf86 reports were preserved separately before these repeats.
These Firefox runs do not add native trusted-input or full-browser-restart cases.
The original intermittent Edge failure and the full acceptance matrix remain open.


Safari42b3b89: workflow34632420779 passed all three synthetic background variants
with9 observations each (18:17:49/51/55Z); generic CI34632420801 passed.
The product-equivalent module worker confirms native external routing, normal
tab context and document IDs checked against webNavigation, with a new ID after
same-URL reload. This is still account/key-free; the product adapter, private-window
rejection, full lifecycle and real Identity/Entry acceptance remain required.
Details and the earlier setup failures are retained in the Safari probe note.
