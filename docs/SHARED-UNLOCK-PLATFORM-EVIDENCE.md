# Shared unlock platform evidence

CVT-587, part of CVT-583. This is a synthetic browser capability probe, not an
implementation of shared unlock or evidence of production support. No Member
key, account, credential, backend session or Palladin environment is used.

## Required boundary

The approved target is automatic Web <-> Extension login/unlock in one normal
browser profile without a desktop application or native broker. Every handoff
must independently authenticate the recipient installation and profile, including
an official-artifact check that cannot be satisfied by a modified unpacked build
with the same extension ID. A copied profile must not inherit that authority.

The 2026-09-10 lifecycle correction permits a new authenticated handoff from a
still-valid unlocked peer after a worker restart, and permits independent
operation after closing the source Web tab. It does not weaken the recipient
authentication requirement, persist keys, reuse an old handoff, override a lock
or reset a session deadline.

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
store-installed Palladin artifact. These observations disprove the sufficiency
of the tested signals; they do not establish that every possible browser trust
mechanism is impossible, nor attest an installed production extension.

## Independent authority assessment

| Candidate | Evidence and limit | CVT-587 status |
|---|---|---|
| Extension ID or extension-frame origin | The Chrome manifest `key` deliberately preserves the same ID for development. The probe observes different bytes under the same ID/origin. | Insufficient on its own. |
| Peer-reported `management.getSelf()` | Browser metadata is available inside the extension; a response relayed by the candidate extension is still candidate-controlled. | Insufficient on its own. |
| Saved local pairing marker | The synthetic profile copy preserves the marker. | Insufficient on its own. |
| Browser-authored Web sender context | The probe observes allowed origin/top-frame/document context and rejects an unlisted origin. | Useful Web sender boundary; does not attest recipient package/profile. |
| Chrome enterprise platform-key attestation | Official API is ChromeOS-only and policy-restricted. | Does not cover the required ordinary desktop browser matrix. |
| Safari webpage messaging | Apple documents addressing by extension bundle ID and team ID. Exact installed-artifact/profile verification still requires a positive and negative installed-Safari probe. | Not yet verified; not inferred from Chromium. |
| Firefox webpage messaging | Mozilla documents no Web-page `runtime.connect`/`sendMessage` support. A content-script adapter would need its own independently verified boundary. | Adapter and artifact/profile authority not yet verified. |

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
Firefox or Safari. No row has a verified official-artifact/profile trust adapter
from this work. A successful probe command means its limited assertions passed;
it does not satisfy CVT-587, CVT-604 or the parent goal.

Before a Member MK handoff can be implemented, the protocol must identify a
recipient proof issued or verified by an authority independent of that recipient,
then demonstrate acceptance of the official artifact and rejection of the
same-ID substitute and profile copy. A release signature or downloaded artifact
hash alone describes distributed bytes, not which code is answering a live
handshake. Tests of the actual handoff, Identity bootstrap, lifecycle, settings
and all distributed browser/OS artifacts remain outstanding.
