# Safari recipient and document boundary

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
