# LiveKid login specimen

- Public source: https://app.livekid.com/
- Observed: 2026-10-04, unauthenticated initial login, English UI, clean headless Chromium context.
- Report: CVT-675, missing detection/autofill in the user's installed extension; installed build and tab script revision were not established.
- Expected user behavior: identify the visible email/password pair without a native `form`; automatic exact-host fill preserves existing values and never submits. Explicit manual selection may replace the current account.

## Provenance and reductions

`page.html` is the observed `[data-testid="login-form"]` subtree. Input value attributes were removed without reading their values; image source attributes were removed to avoid remote asset requests. Native structure, labels, attributes, inline styles, country/language selectors, recovery/signup links, and the actual `div#login-button` remain. No `form`, button role or submit semantics were added.

External CSS, Vue runtime, production scripts and the surrounding application shell are not included. Both login fields were visibly rendered when observed. This specimen proves DOM classification and synthetic input/change event delivery, not Vue state updates, launcher geometry, trusted clicks or successful sign-in. No authenticated DOM, cookies, storage, HAR or real credentials are included.

## Evidence

- Earlier dirty working-tree implementation: the initial reduced specimen failed username detection and inline launcher discovery before the temporary site-specific fix. That was not current `origin/main`.
- Current main baseline: `npx vitest run src/content/isolated/livekid-login.test.ts` passes all six cases before any LiveKid production change. The generic detector already supports this observed DOM. Consequently this PR adds coverage, not a redundant LiveKid adapter, and does not claim a new RED → GREEN transition on main.
- User adapter: detection, popup fill, automatic no-overwrite, explicit manual replacement, stale-control rejection, and one automatic exact-host fill roundtrip are covered using fake data.
- Agent adapter: this same specimen is available for Agent coverage; Agent injection/submission and live login acceptance are not established by the user adapter tests.
- Chromium real page: public DOM was observed in an isolated context. The earlier compiled detector recognized the visible pair; no credentials were filled and no login was submitted. Current PR artifact real-site acceptance remains unverified.
