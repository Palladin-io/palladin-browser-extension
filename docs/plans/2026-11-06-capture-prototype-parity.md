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

Header polish: shared initial notice chrome and shared React review/saved header use a 12px brand gap and 16px wordmark. The close glyph is now a centered SVG in both renderers. Chromium checks verify icon/button centers and retain stable header pixels in all eight motion cases. 4368 tests and all builds pass.

Unlock error follow-up: the native locked popup now measures feedback height and animates the matching viewport growth instead of scrolling the fixed 292px form. Chromium renderer regression reproduced the old defect; normal/reduced-motion cases pass. Installed Chromium expands 292→313px through intermediate sizes without scrollbar, then accepts a correct-password retry. Full suite: 4368 tests; all builds passed. Same local build path; no merge/release.

Latest animation correction (2026-11-09): saved actions now wait until the 320ms host collapse has finished, then enter over 180ms. The frame footer follows the viewport bottom; outgoing actions are disabled while the secret editor is removed immediately. Card/key remounts carry only action presentation. A new Chromium regression first failed on premature Done, then passed eight login/key × light/dark × reduced-motion scenarios, including bottom anchoring. Unit suite: 4368 passed; all target builds passed. No merge/release; user visual acceptance remains next.

Current: PR123 worktree `capture-notice-parity` includes main #122 and #124 and the scoped iframe implementation. All Review actions stay inline when unlocked; unlock stays browser-owned. Exact pixel shield, identity cards, provider/card icons, fields, autocomplete, captured CVV and saved/draft thumbnail navigation implemented. Unique matching card and default OAuth Vault corrected after real browser tests. Generator PASS2 includes actual 3-word passphrases (preview-only crypto adapter), portal controls, draft retention and exact preview fill.

Accepted: pixel shield, same-notification review, animated resize and stable header. User accepts the specific residual visual-overlay risk after competitor research. Safari16.4 uses a modal top-layer dialog in the same location, blocking background interaction; Safari17+ uses a nonmodal popover. No claim of atomic click-time visibility protection. Official Proton autosave and Bitwarden notification source informed the boundary; vendor implementation code was not copied.

Evidence: installed Chromium TOTP encrypted save passed. The final combined matrix passed login create/update, card create/update (captured CVV and same Entry), API key and OAuth, exact committed thumbnail destinations and packaged provider-logo decoding. Host real Chromium tests pass 320ms resize/reduced-motion, ordinary and foreign overlays, cooldown, repeated interference, and modal fallback/Escape. Generator actual Chromium proof passes. Native editor regression suite passed 26 encrypted writes. Existing credential submission, inline/agent frame and shared unlock browser suites passed their scenarios. Final merged aggregate: 4314 tests / 269 files passed. Final build passed after correcting a nullable provider alt-text type mismatch with the authoritative provider identifier fallback. Dependency audit has no high/critical findings (two existing moderate development advisories).

Platform progress: actual Firefox140 original capture-Port transport, SPA and classic-login review/save passed, including encrypted roundtrips; Firefox155 full login review/save passed. User explicitly cancelled Safari work. Temporary Safari setup was cleaned up; native Safari acceptance remains unverified and is not a release criterion for this task. The already implemented modal fallback remains covered by Chromium simulation. Edge-specific manual acceptance was not performed; Chromium coverage is not a claim of actual Edge execution.

Review round1 on f90eebf completed with two valid in-scope findings, now fixed: edited drafts/destination survive thumbnail handoff through native-only one-shot session memory (max8, original lease, lock/navigation/expiry invalidation), and Firefox structured-clone navigation accepts an explicitly cleared pendingCapture. The actual Chromium handoff test confirms no transfer write and encrypted native save of edited password/custom fields into Team; partial custom fields survive. Independent focused security review found no blocker. A StrictMode duplicate-consumption regression was also fixed.

CI on f90eebf passed builds/units/native capture/inline matrix/TOTP/host, then exposed a generator layout race during option changes. A deterministic held-response test proves loading-status row removal could redirect a Symbols click onto Dismiss. Status now stays inside the existing preview row; default browser suite and regression pass.

Previous delivery: e7799d4 passed head-specific CI and cloud round2; both round1 threads were answered/resolved. No merge or release authorized.

Current feedback batch: fixed masked cc-csc being classified as a portal password field, preserved masked 3/4-digit CVV capture, restored short catalog-reference icons and update-review icon fallback, aligned auto-update checkbox, and labeled Vault/account metadata. The iframe waits for actual review content and only the host animates height, eliminating the initial 260→100→553px contraction and competing nested transitions. All 4339 tests / 271 files and target builds pass. Actual Chromium matrix verifies card create/update on the saved portal-login host: CVC stays empty before user entry and the entered CVC survives encrypted save. Faithful CaptureLab specimen covers automatic/manual/Agent distinctions and 3/4-digit capture. Motion tests sample every animation frame, stable 68px header and normal/reduced-motion paths. Initial/update/TOTP PNG decoding passes in browser fixtures; the configured production catalog availability for the user's TOTP site remains unverified.

Batch df51d05 passed head-specific CI Test42488670361 and cloud review with no findings. Follow-up testing exposed real pixel flashes that geometry-only checks missed: Chromium's color-scheme canvas behavior and dark popup CSS overrode frame transparency. Frame-only canvas rules now keep the notice visible during loading. Production preferences, decoded assets, screenshot pixels and actual child-frame samples cover 8 light/dark/reduced-motion login/key scenarios; review→saved header pixels remain identical, including secret remount.

Owner chose site mute beside Dismiss, rejecting the header-menu proposal. A split Dismiss reveals the localized site preference; ordinary Dismiss remains independent and the group keeps Review's width. Pointer/keyboard/Escape tests cover the menu. Installed Chromium preference persistence/re-enable and ordinary dismiss passed within the full 26-encrypted-write credential suite; 4339 unit tests and all builds passed. Next: publish combined follow-up and await its head-specific CI/cloud review. Same local dist/chromium folder; no merge/release.

Current extension of accepted design: user approved reusing split Dismiss across all capture notices and Review surfaces. Shared isolated helper and React footer cover login/update, card/key, OAuth and automatic TOTP; saved stays Done-only. Worker-owned site/profile mute now reaches all paths; passive TOTP respects mute while explicit scans remain intentional. Native-frame Escape delegates to the opened preference menu instead of destroying Review. 4367 tests /272 files and all builds pass; installed Chromium capture matrix opens/closes every menu and still completes encrypted saves. Installed Chromium verified all ten notice/review mute paths (login/key/card/OAuth/TOTP), source-bound persisted site, subsequent suppression and zero Entry writes. This caught the frame-side mute rejection, now removed only for this scoped operation; trusted-action gates remain. Repeated same-identity notice updates retain the open menu. One full-suite run exposed an unrelated SharingOverview observer timing failure; isolated and full reruns passed (4367 tests). Next: same PR review/CI. No merge/release.
