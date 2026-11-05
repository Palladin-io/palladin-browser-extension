# Capture flow implementation plan

> For agentic workers: execute with superpowers:executing-plans. Preserve this checkpoint across resumptions.

**Goal:** Implement the approved capture review experience across the shared Chromium, Firefox and Safari extension targets.
**Architecture:** Reuse popup Entry identity, Button, FilterSelect and entry editors. Keep page notices value-free and review inputs in extension-owned surfaces. Worker-owned authorization, exact-host matching, document/session binding and encryption remain authoritative.
**Tech Stack:** React 19, TypeScript, MV3, Vitest, synthetic browser fixtures.
**Spec:** Root `design/card-capture-review.html`, accepted 2026-11-05 (site matching v3), and the decisions below. The HTML is a visual reference, not production markup.

## Accepted scope
- Card, API key, login capture/password update, sign-in method, TOTP and inline strong-password suggestion.
- Stable branded header, neutral summary shared between notice/review/saved, separated footer, restrained success state, animated expansion/collapse with reduced-motion support.
- Prefer native/default extension popup, never force side panel; top-right value-free page notice. Preserve unsupported-popup manual-toolbar fallback.
- All existing-entry controls are actual autocomplete comboboxes, using Entry icons and rows; initially show exact-host eligible matches, 5 rows loaded then batches of 5, full eligible-list search. One eligible account may be preselected; ambiguous accounts require choice. Creation offered when no eligible match exists. Never match cards by merchant, brand or last four alone.
- Card name defaults to recognized network (Visa/Mastercard/Amex etc), editable generic fallback; capture CVV when present and keep it masked and initially populated. Existing same-card update requires worker-authoritative matching and explicit save.
- Complete type-specific editable fields; Notes/Additional details and Additional fields collapsed; extension custom field editor, TOTP support. Login URL visible; update-account checkbox directly below URL.
- Site favicon through existing trusted public-asset mechanism, provider icon right, summary opens the exact item/draft in the extension.
- Inline generator anchored to password input, compact heading, configurable password/passphrase options with animation and existing generator service.
- English and Polish, light/dark/system, keyboard and screen reader behavior.

## Global constraints
- No plaintext persistent storage, telemetry or logging. No new extension permissions.
- Preserve zero-knowledge, sender/tab/document/origin checks and in-memory expiry/invalidation.
- Never relax automatic autofill policy or infer account equality from host/email alone.
- Shared code for all three browser builds; runtime evidence is reported separately from packaging.
- No merging, releases or installing into user profiles. Publish a ready PR and run CI/review under current repository instructions.

## Review focus
- Lock, navigation, invalidation or worker loss during review/save cannot restore stale drafts.
- Multiple same-host accounts and existing TOTP never silently overwrite the wrong account.
- Cross-origin payment frames retain source binding while notice uses top-level placement.
- Keyboard and touch selection, long labels, narrow popup/sidebar, dark and reduced motion.
- Save errors preserve the current form without falsely displaying success; successful save retains only safe summary.

## Task 1: Shared entry autocomplete and TOTP capture
Files: `src/popup/components/EntryAutocomplete.tsx`, colocated tests, `src/popup/capture/TotpCapturePrompt.tsx` and tests, `src/popup/redesign.css`, EN/PL catalogs.
- [x] Test combobox typing/selection, keyboard/Escape/outside click, 5-item batches, search beyond first batch, empty and disabled state (RED).
- [x] Implement with existing EntryIcon, entry-head styles and popup primitives; reuse current trusted eligible targets rather than broadening host matching (GREEN).
- [x] TOTP regression tests: one/multiple/no existing targets, creation only for no matches, confirmed replacement, retained failed draft, saved state (RED→GREEN).
- [x] Integrate neutral animated capture shell and review/save lifecycle; retain scan outcomes and stale guards.

## Task 2: Captured card/key review and popup routing
Files: `src/popup/capture/SecretCapturePrompt.tsx`, `src/popup/entries/AddEntryForm.tsx`, `src/background/capture/secret-*`, `src/shared/messaging/secret-capture.ts`, related tests.
- [x] Pin CVV initial-value loss and hostname card naming with RED tests; fix using bounded card-network recognition and existing candidate.
- [x] Reuse field editor with compact capture mode, collapsed details/custom fields and custom selects; shared notice/review/saved shell.
- [x] Implement authoritative same-card update path with exact normalized PAN comparison, preserving other fields, explicit choice/save and negative mismatch tests.
- [x] Prefer popup across browser adapters; retain manual toolbar fallback and invalidation behavior.

## Task 3: Login/update and federated sign-in
Files: credential/federated coordinator/runtime, shared messaging, popup capture surfaces, content notices and tests.
- [x] Extend native review contracts to carry complete editable fields/custom fields and eligible target identity; pin rejection cases before changes.
- [x] Integrate shared shell/combobox, site matching and conditional create, provider icon, URL then auto-update checkbox.
- [x] Keep account/provider confirmation and worker save authorities; add encrypted round-trip coverage.

## Task 4: Page notice and inline generator
Files: `src/content/isolated/credential-toast.ts`, secret/TOTP notices, generator suggestion and related tests.
- [x] RED tests for top-right placement, frame routing, compact footer, review open, and generator option interaction.
- [x] Implement branded notices with no sensitive page inputs, actual generation options anchored to password input, animated options, reduced motion.
- [x] Synthetic Chromium acceptance for positioning/focus/navigation; do not claim Booking reproduction without a faithful observed fixture.

## Task 5: Integration, browser matrix and handoff
- [x] Focused tests during work; once integrated run `npm test`, `npm run build`, dependency audit and applicable capture/signin/generator/TOTP browser fixtures.
- [x] Review light/dark at popup/sidebar widths, independent design and whole-branch review; fix important findings.
- [x] Update source docs and root Brain session/release checklist with actual implementation and platform evidence; prepare extension and root documentation PRs. No merge.

## Checkpoint
- Worktree: `.worktrees/capture-flow-redesign`, branch `feat/capture-flow-redesign`, rebased onto extension main `1b9946b` (includes declared-field capture and reinstall fixes).
- Scope: Chrome/Edge, Firefox, Safari; no web/mobile changes. Approved prototype remains the UI reference.
- Implemented all accepted capture/editor/generator behavior above. Independent code and design findings addressed, including draft invalidation, saved-state retention, active normal-window selection, native Review click default cancellation, bounded scrolling and floating selects.
- Final `npm test`: 255 files / 4149 tests passed. `npm run build` and Chromium debug build passed. High audit gate passed; two existing moderate Vitest dev-tool advisories remain.
- Synthetic Chromium card/key (18 cases, 10 encrypted writes), credential (26 encrypted writes), federated, TOTP and generator acceptance passed. Native popup and narrow sidepanel passed field/footer/menu geometry in both themes. Agent live/frames, inline, credential-submission and shared-unlock CI browser gates passed; shared-unlock platform probe remains explicitly unproven rather than a platform certification.
- No real Booking transaction or Firefox/Safari runtime certification. Their packaging passed; real-browser release acceptance remains required.
- Delivery: extension PR #118 and root documentation PR #245. Initial native CI passed; root cloud review clean. Cloud round 1 identified draft-refresh and toolbar-fallback defects plus stored-PAN compatibility handling. All addressed with regressions (4158 full-suite tests, then two additional focused race cases; 33 focused tests passed). Next: validate updated head in CI and cloud round 2. No merge authorization. Unrelated dirty checkout preserved.
