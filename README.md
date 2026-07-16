# palladin-browser-extension

Palladin browser extension - user autofill + secure AI agent fill (Manifest V3).
Zero-knowledge: keys never leave your device.

Two use cases:

1. **User autofill** - a classic password-manager experience: unlock, fill,
   capture, generate, TOTP.
2. **Agent fill** - a browser-using AI agent logs in through the extension while
   the secret bypasses the LLM context, gated by an explicit grant.

## Status

Scaffold. This repository currently ships the MV3 skeleton: a service worker, a
placeholder popup, three-layer content scripts (isolated + main world), and the
typed message bridge that everything else builds on. No crypto and no secrets
yet - the crypto package and the fill engine arrive in later phases.

## Requirements

- Node.js >= 20

## Development

```bash
npm ci          # install
npm run dev     # Vite dev server with HMR
npm run build   # typecheck + production build -> dist/
npm test        # Vitest
```

### Load the unpacked extension

1. `npm run build`
2. Open `chrome://extensions` (Chrome / Brave / Edge / Opera) and enable
   **Developer mode**.
3. **Load unpacked** and select the `dist/` folder.

The same build targets all Chromium browsers. Firefox and Safari builds land as
separate manifest overlays in a later phase.

### Icons

`icons/*.png` are placeholders. Regenerate them with:

```bash
node scripts/generate-icons.mjs
```

## Architecture

```
page main world  <-- window.postMessage -->  isolated world  <-- chrome Port -->  service worker
```

See [`AGENTS.md`](./AGENTS.md) for the full architecture, security rules, and
conventions. Security reports: [`SECURITY.md`](./SECURITY.md).

## License

[GPL-3.0](./LICENSE)
