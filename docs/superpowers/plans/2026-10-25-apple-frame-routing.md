# Apple framed login implementation plan

> **For agentic workers:** Use superpowers:executing-plans; implement task-by-task with TDD.

**Goal:** Route explicit Agent Inject to the authentic Apple login document without widening credential domains.

**Architecture:** Preserve the outer tab binding, select a unique visible direct HTTPS same-site login frame using browser-owned frame/document identities, and revalidate before secret delivery. Nested technical frames must not invalidate the sole direct login target; additional direct siblings remain unsupported because URL equality alone cannot bind visibility to browser identity. Reuse the existing live-form adapter; do not enable the experimental rollout globally or weaken legacy map validation.

**Tech stack:** TypeScript, Chrome extension APIs, Vitest, existing Rust Inject runtime.

**Spec:** User-approved design in this conversation, 2026-10-25: same registrable site for outer/child; exact Entry host for the credential-bearing child; document-bound delivery; reject ambiguity and navigation races.

## Global constraints
- No credentials, input values, tokens, or authenticated DOM in observations or fixtures.
- No wildcard Apple domain authorization; no new browser permissions.
- Preserve unrelated local changes in other worktrees.
- Synthetic tests are not real Apple acceptance.

## Review focus
- Additional unrelated frames must not reject the legitimate login.
- Duplicate URLs, including hidden frames, must never redirect secret delivery.
- Same-site sibling/descendant targets must not inherit the saved credential host.
- Replaced outer/child documents must invalidate prepared writes.
- Legacy and multi-step login must retain their existing behavior.

## Task 1: Establish the actual path
- [ ] Inspect value-free runtime mode and installed extension provenance; compare with source.
- [ ] Confirm the observed Apple frame structure through public browser state, without field values.
- [ ] Record whether live discovery was enabled. The source defaults to disabled when PALLADIN_EXPERIMENTAL_LIVE_FORMS is absent; do not attribute a legacy-path mismatch to frame enumeration without evidence.

## Task 2: Unique frame selection
Files: src/background/agent/frame-routing.ts and frame-routing.test.ts.
Interface: preserve prepareLoginFrame(top, transport, isActive) and FrameTransport.
- [ ] Add synthetic regression: legitimate Apple-shaped direct child plus nested technical third frame; preparation and delivery must reach only the child document. Run and record RED.
- [ ] Replace total frame-count restriction with unique candidate identity checks, retaining duplicate-URL rejection across browser-owned frames and visible hints.
- [ ] Recheck target uniqueness and current document before each write; preserve cancellation routing.
- [ ] Add rejection tests for duplicate URL, two login candidates, changed document, foreign/sibling host and insecure frame.
- [ ] Run focused frame/provider/security tests, then full npm test and npm run build.

## Task 3: Real acceptance and review
- [ ] Confirm whether a runtime change is necessary; do not change global feature rollout to mask a routing defect.
- [ ] Verify synthetic Chromium frame/navigation behavior via the authorized browser connection; do not use Playwright for user browser control.
- [ ] After the owner loads the reviewed build, retry explicit Apple Inject with current same-tab routing and live discovery enabled for that invocation only; preserve grant approval and human MFA.
- [ ] Open component PR, run applicable CI/Codex review, and record actual-site outcome separately.

## Checkpoint
Design approved. Isolated worktree fix/apple-frame-routing starts at extension main 08a1aef. No production changes yet. Confirmed source limitations: live mode defaults off in the development runtime; extension frame routing requires exactly two total frames. Actual triggering cause and loaded-build identity remain unconfirmed.

Ruling: retain the single direct child and single DOM iframe requirements, allowing only nested technical frames. Independent review demonstrated that stale iframe.src can misassociate visibility when siblings exist; do not ship a URL-only sibling expansion.

Evidence: initial synthetic frame routing test RED; exact-host negative tests RED; initial full suite 3576 PASS before narrowing. Final checks: 3577 tests PASS; all-target build PASS; Chromium debug build PASS. Independent follow-up review requested. Live flag was unset in this shell and wrapper does not set it; explicit live invocation reached provider-not-ready, not a successful login. No retry or credential fallback attempted. Real Apple acceptance requires verifying the loaded extension and retrying after a changed condition.
