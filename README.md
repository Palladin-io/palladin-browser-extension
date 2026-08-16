# Palladin Browser Extension

Palladin's Manifest V3 browser extension is under active development. It has one
product surface with two explicitly separated authorization paths:

1. **User autofill** - a classic password-manager flow initiated by the user.
2. **Agent fill** - an authenticated Palladin Runtime asks the same extension to
   fill an approved credential without returning its value to the AI model.

Neither path trusts the visited page. Agent fill does not reuse or weaken the
user-autofill authorization path, and user autofill never requires an Agent grant.

## Status

The current development branch contains MV3 build foundations for the Chromium
family, Firefox, and Safari, plus in-memory session and key lifecycle, encrypted
Vault Protocol 2 sync/read/write, popup unlock and domain-matched credential
selection, explicit generated-password save/update, TOTP, and card save/autofill
for cardholder, PAN, expiry, and billing fields. Agent Inject has a typed
`form+values` provider, authenticated channel, and explicit out-of-band runtime
pairing. It stays fail-closed until the user verifies and confirms the runtime's
public-key fingerprint; production native-runtime packaging remains a release gate.
Clipboard Copy is intentionally disabled on Firefox and Safari until those
targets have a reviewed TTL wipe. Cross-browser runtime validation and
production store publication remain in development. Do not use development
builds with production credentials.

See [`docs/STATUS.md`](docs/STATUS.md) for the release gates and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for trust boundaries. The exact
target matrix and known gaps are in
[`docs/BROWSER-COMPATIBILITY.md`](docs/BROWSER-COMPATIBILITY.md).

## Requirements

- Node.js 22 or newer

## Development

```bash
npm ci
npm run dev
npm run build
npm test
```

To load the Chromium development build, enable Developer mode at
`chrome://extensions`, choose **Load unpacked**, and select `dist/chromium/` after
a build.

For a complete local smoke test - sign-in, user autofill, generated-password
capture, card fill, and the macOS Chrome Agent Inject path - follow
[`docs/LOCAL-TESTING.md`](docs/LOCAL-TESTING.md). Use disposable development
data only.

`npm run build` builds all three target manifests. Use `npm run build:chromium`,
`npm run build:firefox`, or `npm run build:safari` for one target, and the matching
`dev:*` script for development. Chrome, Chromium, Brave, Edge, and Opera use the
same `dist/chromium/` artifact. Firefox and Safari are manifest/platform adapters
over the same extension core, not separate Palladin products.

## Security and contribution

Read [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), and
[`SECURITY.md`](SECURITY.md) before changing the extension. Every change goes
through a pull request to `main` with security-boundary tests.

## License and trademarks

Licensed under [Apache-2.0](LICENSE). The license does not grant rights to
Palladin names, logos, or browser-store identity; see
[`TRADEMARKS.md`](TRADEMARKS.md).
