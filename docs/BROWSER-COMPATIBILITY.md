# Browser compatibility

Palladin has one security-critical extension core and three small manifest
targets. These targets are development packaging contracts, not production
support or browser-store certification. Do not use these builds with production
credentials.

## Build targets

| Target | Development floor | Artifact | Current status |
|--------|-------------------|----------|----------------|
| Chromium | Chrome 116-compatible MV3 | `dist/chromium/` | Development baseline for Chrome, Chromium, Brave, Edge, and Opera |
| Firefox | Firefox desktop 140 | `dist/firefox/` | Manifest and bundle foundation; installed-browser validation is pending |
| Safari | Safari 16.4 | `dist/safari/` | Web-extension resources only; Xcode conversion, containing app, and installed-browser validation are pending |

Chrome, Chromium, Brave, Edge, and Opera intentionally share one artifact. Do
not add an Opera fork or a second Chromium overlay. A store may wrap or sign the
artifact differently, but it must not change the runtime bundle or permissions.

Build all artifacts with:

```bash
npm run build
```

Build or run one target with:

```bash
npm run build:chromium
npm run build:firefox
npm run build:safari

npm run dev:chromium
npm run dev:firefox
npm run dev:safari
```

The scripts validate the target before starting Vite. Each manifest is the deep
merge of `manifest/manifest.base.json` and exactly one target overlay. Arrays are
replaced, not appended, so permission differences remain explicit and auditable.

All targets package production, staging, and `localhost:5000` as known API
origins. The shared popup may request one exact custom HTTPS origin (or
`127.0.0.1`) from the browser when the user changes Server in Settings. The
permission is optional until that action; changing the setting signs out and
clears the local encrypted cache.

## Manifest differences

### Chromium family

- `manifest.chromium.json` owns the public-key-derived Chromium extension ID.
  The native-host allowlist is locked to the resulting exact origin
  `chrome-extension://hmljnknogdeonphikmeofcbkikmpokba/`; changing the manifest
  key is therefore a cross-component protocol and packaging change.
- The artifact requests `offscreen` because Chromium's service worker delegates
  timed clipboard clearing to a short-lived offscreen document.
- Chrome, Chromium, Brave, Edge, and Opera consume this same artifact.

### Firefox

- `manifest.firefox.json` sets the stable Gecko ID
  `browser-extension@palladin.io` and a Firefox 140 floor.
- It declares a `background.scripts` fallback alongside the shared MV3 service
  worker entry. Firefox uses the background script because it does not run
  `background.service_worker`; current Chromium uses the service worker.
- Firefox's installation-time data declaration lists `authenticationInfo` and
  `browsingActivity`. Palladin transmits encrypted account and credential data to
  Palladin services. A future paired Agent Inject session will also send the
  active URL to the local runtime; zero-knowledge encryption and a local
  destination do not make that browser-consent declaration disappear.
- The target does not request `offscreen`, which Firefox does not implement.

### Safari

- `manifest.safari.json` sets a Safari 16.4 floor because the extension uses
  `storage.session`, which Safari supports from 16.4.
- The build output is web-extension source, not a distributable Safari app.
  Production packaging must convert it into an Xcode Safari Web Extension and
  ship a containing app.
- Safari native messaging talks to the containing app extension and ignores the
  Chrome-style native host name. The current Agent Inject Native Messaging host
  is therefore not Safari-compatible without a dedicated containing-app adapter.
- The target does not request `offscreen`, which Safari does not implement.

## Known runtime gaps

- Firefox and Safari do not yet have a replacement for Chromium's offscreen
  clipboard-clear path. Copy controls are therefore not rendered on those
  targets, and the worker rejects copy reveal/arm commands before decryption.
- Firefox Native Messaging requires a separately installed host manifest whose
  `allowed_extensions` includes the Gecko ID. That installer and end-to-end
  validation are pending. The extension sends no session frame without an
  independently verified pinned host signing key.
- Safari Agent Inject requires a containing-app/native-extension adapter. It is
  not enabled by producing `dist/safari/` alone.
- Automated checks currently cover generated manifests, TypeScript, and bundle
  creation. They do not replace installed-browser or store-review testing.
- The shared popup implements explicit out-of-band public-key pairing without
  TOFU. Chromium uses the fixed manifest-key-derived extension origin. Firefox
  still needs a reviewed host installer/origin adapter, while Safari needs its
  containing-app adapter; storing a pin alone does not claim runtime support on
  those targets.

These gaps are why the Firefox and Safari rows describe a build foundation, not
feature parity or production support.

## Platform references

- [Cross-browser MV3 background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Firefox browser-specific settings and extension IDs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
- [Firefox built-in data collection consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Safari web-extension compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)
- [Safari native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
