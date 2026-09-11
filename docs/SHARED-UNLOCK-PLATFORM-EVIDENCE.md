# Shared unlock platform evidence

CVT-587, part of CVT-583. This is a synthetic browser capability probe, not an
implementation of shared unlock or evidence of production support. No Member
key, account, credential, backend session or Palladin environment is used.

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
| Firefox webpage messaging | Mozilla documents no Web-page `runtime.connect`/`sendMessage` support. A content-script adapter would need its own independently verified boundary. | Adapter and actual browser-route authority not yet verified; no original-profile attestation required. |

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
lifecycle, settings and all supported browser/OS artifact tests remain outstanding.

## Firefox manifest-resource candidate - 2026-09-11

A new **research probe**, not an approved runtime adapter, tests whether the Web
can relate a Firefox-generated resource origin to the configured Gecko ID by
fetching the canonical `/manifest.json` directly from that `moz-extension:` origin.
Candidate URLs/claimed IDs and `runtime.getManifest()` relayed by the peer are
not authority. The tested Web fixes the resource path itself, uses no cookies,
rejects redirects and compares the retrieved Gecko ID with an independent fixed
expected ID; it also records the browser-authored origin/source of an extension
iframe. The product manifest, permissions and shared-unlock routes are unchanged.

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
