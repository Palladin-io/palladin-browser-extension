# Palladin Browser Extension

Palladin's Manifest V3 browser extension is under active development. It has one
product surface with two explicitly separated authorization paths:

1. **User autofill** - a classic password-manager flow initiated by the user.
2. **Agent fill** - an authenticated Palladin Runtime asks the same extension to
   fill an approved credential without returning its value to the AI model.

Neither path trusts the visited page. Agent fill does not reuse or weaken the
user-autofill authorization path, and user autofill never requires an Agent grant.

## Status

The current development branch contains the Chromium MV3 foundation, in-memory
session and key lifecycle, encrypted Vault protocol/cache, popup unlock and
domain-matched entry selection, TOTP, generation, and a typed content-script
bridge. Native-runtime pairing and production store publication remain in
development. Do not use development builds with production credentials.

See [`docs/STATUS.md`](docs/STATUS.md) for the release gates and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for trust boundaries.

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
`chrome://extensions`, choose **Load unpacked**, and select `dist/` after a build.

One Chromium build targets Chrome, Chromium, Brave, Edge, and Opera. Future
Firefox and Safari builds are manifest/platform adapters over the same extension
core, not separate Palladin products.

## Security and contribution

Read [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), and
[`SECURITY.md`](SECURITY.md) before changing the extension. Every change goes
through a pull request to `main` with security-boundary tests.

## License and trademarks

Licensed under [Apache-2.0](LICENSE). The license does not grant rights to
Palladin names, logos, or browser-store identity; see
[`TRADEMARKS.md`](TRADEMARKS.md).
