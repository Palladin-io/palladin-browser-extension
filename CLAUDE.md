# Palladin - Browser Extension

Manifest V3 browser extension for Palladin, a zero-knowledge password manager for
people and their AI agents. Two jobs: classic **user autofill** (unlock, fill,
capture, generate) and **secure agent fill**, where a browser-using agent logs in
through the extension while the secret bypasses the LLM context. All
encryption/decryption happens on-device - the server never sees plaintext.

## Security First

**This is a password manager. Users trust us with their most sensitive
credentials. Security is a hard constraint, never a trade-off.** PR reviewers must
treat any violation below as a Critical (blocking) finding.

- **Keys live only in `chrome.storage.session`** (memory-backed, cleared when the
  browser closes) or in JS memory. NEVER `localStorage`, `sessionStorage`,
  `IndexedDB`, `chrome.storage.local`, or `chrome.storage.sync`. Auto-lock and
  wipe keys on lock/logout.
- **No inline crypto.** All encryption/decryption comes from the shared crypto
  package (bundled locally - MV3 forbids remote code). Never hand-roll crypto in
  a background handler, content script, or popup component.
- **Local cache holds ciphertext only.** Never persist a decrypted secret, key,
  or plaintext field to disk in any form.
- **Never leak secrets to logs.** Passwords, keys, tokens, and mnemonics must
  never reach `console.log`, `debugPrint`, analytics, or diagnostics. Failure
  telemetry is value-free (shape only, never values).
- **Confirmation UI is never in the page DOM.** Approvals, save prompts, and any
  security-relevant prompt render in the native popup or a closed shadow-root
  surface with no text inputs - never as page-injected DOM the site can style,
  overlay, or read (anti-clickjacking).
- **Strict eTLD+1 origin gate before every fill.** The frame's eTLD+1 (Public
  Suffix List) must equal the entry's registered domain; HTTPS-only; re-checked
  after navigation. Subdomains do NOT match by default (per-entry opt-in). An
  entry with no domain is fail-closed.
- **Fill is driven by grant or explicit user choice, never by page content** -
  the defense against prompt-injection. A page cannot talk the extension into a
  fill.
- **Security over convenience.** If a shortcut weakens the model, it is not
  acceptable regardless of deadline pressure.

## Architecture

Three cooperating layers plus a typed message bridge that is the foundation for
passkeys and agent fill. Build it correctly - everything else in this scaffold is
a stub that plugs into it.

```
page main world  <-- window.postMessage -->  isolated world  <-- chrome Port -->  service worker
   (untrusted)         (validated bridge)      (enforcement)         (routing)        (gatekeeper)
```

- **Service worker** (`src/background/`) - bootstrap, Port routing, session
  state. Later: sync engine, push registration, grant-gated dispatch. It is the
  trust boundary: it never performs a security-sensitive action on the strength
  of a page-originated message alone.
- **Popup** (`src/popup/`) - thin React surface (unlock, list, search, generator,
  settings). Heavy management deep-links to the web panel.
- **Isolated-world content script** (`src/content/isolated/`) - runs in the
  extension's isolated world; the enforcement point. Validates every main-world
  message (source + origin + nonce + direction + payload type) before relaying it
  to the worker, and relays worker replies back. Field detection and inline menu
  live here. Zero crypto: it only ever receives a ready-to-use value after the
  worker has cleared every gate.
- **Main-world content script** (`src/content/main/`) - runs in the PAGE's JS
  context, so it is treated as untrusted. It is the slot for the future WebAuthn
  interceptor and cannot reach `chrome.*` or secrets.

### The message bridge (`src/shared/messaging/`)

- **One typed vocabulary, two transports.** Messages are a discriminated union
  (`BridgeMessage`) validated by exhaustive type guards. Between main and isolated
  worlds they travel in a `WindowEnvelope` (channel tag + direction + per-page
  session nonce); between the isolated world and the worker they travel bare over
  a `chrome.runtime.Port` (already page-isolated).
- **The main world shares its JS context with the page.** The envelope fields
  (origin, source, nonce, direction) are defense-in-depth, NOT a trust anchor - a
  hostile page script can observe the nonce. Real trust lives in the worker's
  gates. Say this plainly; do not overstate what the nonce buys.
- **Never widen a payload to `unknown`.** Extend the union so every transport
  stays exhaustively type-checked. A new message type without a guard branch must
  fail the compile.

### Passkeys-ready from day one

The fill path is designed as a registry of `FulfillmentStrategy` objects
(`matches(context)` / `execute(entry, context)`): credentials fill DOM fields
today; passkeys will answer an intercepted WebAuthn call tomorrow through the same
contract and the same bridge. Do not special-case one credential type in a way
that blocks the others.

## Project Structure

```
manifest/          # Manifest source of truth (auditable JSON, merged by build-manifest.ts)
  manifest.base.json       # shared MV3 base
  manifest.chromium.json   # Chromium overlay (Firefox/Safari overlays land later)
  build-manifest.ts        # small pure deep-merge; the ONLY manifest generator
icons/             # placeholder PNGs (regenerate: node scripts/generate-icons.mjs)
scripts/           # build/dev helpers (no deps)
src/
  background/      # service worker: bootstrap, router (pure), session stub
  popup/           # React 19 popup
  content/
    isolated/      # isolated-world content script (bridge enforcement)
    main/          # main-world content script (WebAuthn slot)
  shared/
    messaging/     # typed bridge protocol, validation, Port names
```

## Build & Targets

| Layer | Choice | Notes |
|-------|--------|-------|
| Bundler | Vite + `@crxjs/vite-plugin` | MV3-native: handles worlds, SW module bundling, HMR |
| UI | React 19 + TypeScript (strict) | popup only |
| Manifest | MV3, one Chromium build | Chrome / Brave / Edge / Opera share it |
| Tests | Vitest | node environment; pure units |

- **One build serves all Chromium browsers.** Future Firefox and Safari targets
  are new overlays in `manifest/` selected by `PALLADIN_TARGET`, merged by
  `build-manifest.ts`. Do not fork the base manifest.
- **The manifest source of truth is `manifest/*.json`,** never the generated
  `dist/manifest.json`. Least-privilege review reads our source.
- Verify: `npm ci && npm run build` produces a loadable unpacked `dist/`;
  `npm test` is green.

## Manifest & Permissions

- **Least privilege.** Start permissions are `storage`, `activeTab`, `alarms`
  only - no broad `host_permissions`. `content_scripts` match `<all_urls>`
  pending a dedicated least-privilege review; narrowing this is tracked work, not
  a default to widen.
- Adding a permission or host is a security decision - justify it in the PR and
  keep the base minimal.

## Analytics

Follow the Palladin convention `{component}:{module}:{event}` with the extension
component prefix **`ex`** (e.g. `ex:vault:autofill-used`,
`ex:vault:credential-captured`). UI-only events; business logic is tracked by the
backend. **No `*-viewed` events** - screen/tab views are covered generically.

## Conventions

- **TypeScript strict, no `any`.** `interface` for object shapes, `type` for
  unions. Prefer pure, injectable functions (pass `window`/`crypto` in) so logic
  is testable without a DOM.
- **Copy uses a plain hyphen `-`,** never an em dash or en dash. No all-caps in UI
  (no `text-transform: uppercase`) - render strings in the case written.
- **Colors** mirror the web panel `--cv-*` tokens; do not invent brand hexes
  (brand red is `#EB4747`).
- **Key/ID display** is always shortened prefix + suffix, never prefix-only.
- Co-locate tests next to source (`*.test.ts`). Every bridge/protocol change
  ships with tests covering the rejection paths, not just the happy path.

## Testing

- `npm test` (single run) / `npm run test:watch`.
- Required coverage for the bridge: valid message accepted; and each rejection
  reason exercised (source, origin, non-bridge, direction, nonce, payload). The
  manifest builder has a smoke test asserting MV3 validity and least privilege.

## CI/CD

GitHub Actions on pull requests to `main`:

- `test.yml` - `npm ci` -> `npm run build` -> `npm test`. Triggered by
  `pull_request` (never `pull_request_target`) and uses no secrets, so it is
  safe to run on fork PRs.
- `pr-review.yml` / `fix-pr.yml` - Claude Code review + fix. The secret-using
  jobs are gated to same-repo PRs (`head.repo.full_name == github.repository`),
  so fork PRs never expose secrets. `timeout-minutes: 30`, `--max-turns 120`.

**All changes go through PRs** - CI must pass before merge.

## Compatibility file

`AGENTS.md` and `CLAUDE.md` are maintained as complete, byte-for-byte identical
copies. Every change must update both in the same commit and verify with `cmp`.
