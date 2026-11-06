# Capture Prototype Parity Implementation Plan

> For agentic workers: apply the execution workflow to each independently reviewable component; preserve the existing approved design and unrelated edits.

**Goal:** Reproduce the accepted capture and generator prototype, including interactions, rather than only reusing its notice header.
**Architecture:** Shared capture presentation with source-bound worker commands. Existing cryptography, capture validation and storage boundaries remain authoritative. Capture-only extension iframe remains in the notification. Browser-authenticated Ports and a private dual-port challenge bind the owned frame; top-layer visibility/interference guards mitigate overlay attacks without claiming universal clickjacking prevention. General native API gates remain unchanged.
**Tech Stack:** TypeScript isolated content scripts, React capture editors, MV3 worker, Vitest, Chromium browser acceptance.
**Spec:** root `design/card-capture-review.html`, latest active markup and final CSS/JS overrides; latest user corrections in this thread.

## Constraints

- Chrome/Edge and Firefox; distinguish builds from runtime acceptance. Safari follow-up was explicitly cancelled by the owner; it does not block delivery.
- Same notification expands review and collapses saved state; user has not approved replacing it with a separate popup.
- Generator is attached to the password input, without Entry/Vault fields or save flow.
- No secrets in persistence or diagnostics; crypto remains in shared package.
- One PR: extension #123 / `fix/capture-notice-parity`; no merge or release authorized.

## Review focus

- Actual active mockup nodes override obsolete example configuration (generator config is not its visible UI).
- Previewed generated password must be exactly the value filled; refresh/option changes must invalidate earlier previews.
- Missing or slow favicons, unknown card brand and OAuth provider must have deliberate icon fallback, not empty layout.
- Matching-entry defaults, no-match creation, ambiguous identities and TOTP replacement must preserve consent and data.
- Navigation, lock, hostile page overlays and small viewports must not silently change the trusted action or expose values.

## Three verification passes

- [x] Pass 1: compare every component and state with active prototype, record exact discrepancies.
- [x] Pass 2: compare the corrected implementation visually and exercise every transition, EN/PL and light/dark.
- [x] Pass 3: independently inspect the installed extension build against the same matrix; reject missing/changed flows even when unit tests pass.

## Tasks

### Generator
- [x] Inspect active prototype `#inline-generator` (line52), final CSS39/42/45 and handlers199–202/258–269.
- [x] Add failing observable preview/regenerate/use and options tests.
- [x] Implement bound preview transport and exact UI in generator-suggestion, capture protocol/coordinator and necessary launcher wiring.
- [x] Verify preview equality, inert animated options, custom selectors, range12–40/default20, passphrase3–6/default4, separators, dismiss/close/focus and no persistence in real browser.

### Capture surfaces
- [x] Record notice/review/saved discrepancies for login/update/card/key/OAuth/TOTP with exact source evidence.
- [x] Restore identity card, icons, title/source copy, fields/order, matching autocomplete and compact saved state as approved.
- [x] Test selected item navigation and transitions, not only component rendering.

### Brand and Review boundary
- [x] Detect asset drift: prototype embedded shield exactly matches packaged icon-128.png (SHA256 0171096b…), while notice used logo-source.png. Restore exact prototype derivative; older unrelated local checkout has smooth shield.
- [x] Request required product decision on inline-vs-browser-owned surface. Prior iframe experiment is excluded due confirmed visual-overlay bypasses and unsupported child-document lookup.
- [x] Resolve decision without silently substituting a popup or weakening approval integrity.

## Checkpoint

Current: PR123 worktree `capture-notice-parity` includes main #122 and the scoped iframe implementation. All Review actions stay inline when unlocked; unlock stays browser-owned. Exact pixel shield, identity cards, provider/card icons, fields, autocomplete, captured CVV and saved/draft thumbnail navigation implemented. Unique matching card and default OAuth Vault corrected after real browser tests. Generator PASS2 includes actual 3-word passphrases (preview-only crypto adapter), portal controls, draft retention and exact preview fill.

Accepted: pixel shield, same-notification review, animated resize and stable header. User accepts the specific residual visual-overlay risk after competitor research. Safari16.4 uses a modal top-layer dialog in the same location, blocking background interaction; Safari17+ uses a nonmodal popover. No claim of atomic click-time visibility protection. Official Proton autosave and Bitwarden notification source informed the boundary; vendor implementation code was not copied.

Evidence: installed Chromium TOTP encrypted save passed. The final combined matrix passed login create/update, card create/update (captured CVV and same Entry), API key and OAuth, exact committed thumbnail destinations and packaged provider-logo decoding. Host real Chromium tests pass 320ms resize/reduced-motion, ordinary and foreign overlays, cooldown, repeated interference, and modal fallback/Escape. Generator actual Chromium proof passes. Native editor regression suite passed 26 encrypted writes. Existing credential submission, inline/agent frame and shared unlock browser suites passed their scenarios. Final aggregate: 4311 tests / 269 files passed. Final build passed after correcting a nullable provider alt-text type mismatch with the authoritative provider identifier fallback. Dependency audit has no high/critical findings (two existing moderate development advisories).

Platform progress: actual Firefox140 original capture-Port transport, SPA and classic-login review/save passed, including encrypted roundtrips; Firefox155 full login review/save passed. User explicitly cancelled Safari work. Temporary Safari setup was cleaned up; native Safari acceptance remains unverified and is not a release criterion for this task. The already implemented modal fallback remains covered by Chromium simulation. Edge-specific manual acceptance was not performed; Chromium coverage is not a claim of actual Edge execution.

Next: finish native federated regression fixture, merge main PR124, run final checks, publish PR123 update and bounded cloud review, update Brain checkpoint. The independent component/state comparison and installed EN/PL light/dark visual checks are complete. New evidence corrected notice primary color, dark provider tile and TOTP label spacing; generator caption geometry matched the rendered prototype and required no production change. Pending thumbnail navigation opens the exact draft with no write. Native federated regression fixture adaptation is the remaining local browser check. No merge or release authorized.
