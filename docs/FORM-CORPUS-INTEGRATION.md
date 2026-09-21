# Production form corpus integration

Status: integration in progress on current extension main, 2026-09-21.

## Scope and authoritative evidence

The owner expanded the target to100 Global,100 Poland and100 Europe positions
(EU + UK + EFTA). A service may occur in several regions; shared identity
providers may be reused only where the redirect was observed. A fixture count
is not a completed service or a successful live authentication.

Source ledger: `tests/fixtures/forms/coverage.json`. Selection evidence and
provisional lists: `selection-sources.json` and `regional-shortlists.json` beside
it. Their34 source lists are frozen observations; the Polish Ahrefs list measures
organic search, and the country lists do not establish an aggregate Europe
traffic ranking. Candidate eligibility and regional selection remain incomplete.

## Recovered observations

The earlier local corpus was outside Git on the `feat/cvt-626-agent-submissions`
worktree at7120fac. This integration preserves those specimen files and moves
their tests to current main37a0268. It does not import the old runtime or
restore stored form-map execution.

| Evidence | Count | Meaning |
| --- | ---: | --- |
| Authentication specimens with case metadata |198|121 login,77 registration screens |
| Distinct observed services |119|At least one recorded screen |
| Full-form specimens |121|Observed form structure, not full account flow |
| Partial specimens |77|72 identifier,2 account-details,1 name,1 verification,1 cross-frame |
| Services with both flows marked observed |45|Source ledger status, not live success |
| Non-authentication negative specimens |2|Do not count toward regional coverage |

Existing main fixtures are preserved. The only overlapping case metadata
(`aws-root-identifier-2026-09-18/case.json`) retains main's more specific
`syntheticLiveLogin` evidence instead of the historical alternate acceptance field.
No source specimen has been changed to make a test pass.

## Fidelity and safety

Each versioned case records the public source, date, locale, reductions and
adapter expectations. HTML contains the observed subtree; computed CSS is a
projection of its visibility/layout. Page shells, production JavaScript and
unobserved transitions are not reproduced. Local event simulations must remain
labelled synthetic. See `FORM-REGRESSION-TDD.md`.

An initial scan of212 HTML files found no executable script tags, inline event
handlers or populated editable input value attributes. This narrow check does
not prove all sanitization or fidelity requirements; the corpus verifier and
per-case review remain required. No live account credentials belong in fixtures.

## Verification commands and unfinished gates

- `npm run check:form-corpus`: verify source/coverage consistency and report gaps.
- `npm run test:form-corpus`: current shared detection/user/capture regressions.
- `npm run test:browser:form-corpus`: actual built Chromium adapter replay with
  synthetic data. Production authentication and registration remain untested
  unless separately recorded.

Harness adaptation and test results are pending. Unsupported old adapter APIs
are not imported, skipped or counted as passing support. A failing current
capability remains a concrete regression to fix. Fixture replays cannot prove
post-submit behavior absent from the recorded observation.

Remaining completion gates: finish regional selection; observe missing login and
registration stages; preserve production provenance; make supported regression
assertions pass on current implementation; complete relevant Chromium replays,
review and CI; record live results and blockers separately. This document does
not mark the requested corpus complete.

## Current integration results

Baseline current-adapter replay (before viewport correction):200 specimen rows,
200 expected shield-count/closed-root assertions passed; this does not verify
position, user fill or capture. Agent login64/121 passed,57 failed;77 registration
specimens and2 non-auth specimens were reported outside this live-login adapter.
Baseline usedheight2000; preserved report is explicitly marked with that limitation.
The harness now uses both recorded viewport dimensions.

Failure analysis separates45 no-form,8 challenge and4 stale outcomes. Some are
implementation gaps; others require re-observation because older reduction omitted
input-submit captions or no post-input activation was observed. Six challenge
markers are CAPTCHA boundaries; do not remove them to claim support.

Three old capture expectations were corrected against the owner-approved identity
selection rule:24ur/Krone require the email/nickname choice; A Bola explicitly
marks its username control. Case metadata records why; observed DOM did not change.

The first shared action-label fix reuses the same bounded login captions in normal
and deferred Agent discovery, including public input-submit values and aria-label.
Three additional exact captions come from recorded specimens. It retains native
action, origin, document, scope, expiry, single-use and no-fill-submit boundaries.
Focused Chromium replay with recorded viewport passed24ur, Bankier, Record, RTE
and TV2. Aftonbladet remains RED because its disabled action has no recorded
activation behavior. Synthetic tests reject social/signup/reset/delete actions
and label mutation before commit. No real-site authentication is inferred.

The observation helper now preserves method/encoding attributes for new captures.
Its synthetic projection regression was RED for droppedmethod, then all5 helper
tests passed. Older specimens are not retrospectively assigned unknown methods.

Final focused validation:131 relevant tests passed, typecheck passed, and the five
localized/input-action specimens passed the rebuilt Chromium replay. Independent
review caught a button payload being mistaken for a caption; synthetic REDs for
Delete/Create account with value=submit now pass after restricting value captions
to input submit/button controls. The full unit run has2952 tests:2948 passed,
4 failed,0 skipped. The four failures remain the Bilibili/Meczyki legacy explicit
action expectations; they are not removed or marked passing.

Machine-readable evidence lives in `docs/form-corpus/`: source fixture SHA256
snapshot, qualified initial adapter baseline, and final five-case replay with
production-file and harness digests. No current corpus-wide GREEN is claimed.

## Combined login with an initially disabled action

The current deferred adapter now prepares an unambiguous native form containing
both username and password while its sole native login action remains disabled.
It reuses shared login classification, rejects extra fields, registration and OTP,
and never changes the disabled state itself. Only the page can activate the action;
the existing separate, single-use commit still revalidates the live action.

Four unmodified production specimens (Fandom, Filmweb, Twitch and Gazeta) reproduced
missing initial discovery before the fix and now pass that assertion. Their
post-input activation remains unobserved, so these results are discovery-only,
not successful full specimen replays or real authentications. A separate synthetic
Chromium scenario verifies asynchronous page activation, no submit during fill,
separate commit, replay rejection and continuation to TOTP.

Validation:82 deferred tests passed, typecheck passed, and all9 agent-live Chromium
scenarios passed. Full unit run:2972 total,2968 passed,4 failed,0 skipped. The same
Bilibili/Meczyki explicit-action requirements remain RED. Read-only independent
review accepted this bounded change without blockers. No installed user extension
was replaced; this is a PR51 candidate.

## Amazon action re-observation and regression

A focused public Chrome inspection on2026-09-21 corrected the initial diagnosis:
Amazon's submit input has no value attribute. Its accessible caption comes from
`aria-labelledby`, and its opacity is0.01 over a visible sibling label occupying
the same rectangle. The old specimen already preserves both facts. See
`form-corpus/amazon-action-observation-2026-09-21.json`; no old HTML/CSS was rewritten.

Shared action discovery now resolves a bounded, complete IDREF caption within
the same Document/ShadowRoot. Execution signatures preserve both the referenced
caption and the original button text/public input caption, rejecting mutation of
either after preparation. A bounded native-action visibility exception requires
a visible sibling label at the same bounds; opacity-zero controls, credential
fields, missing/hidden/distant labels and page overlays remain blocked. This
shared DOM helper applies to mapped Inject and live discovery, not only Amazon.

The Amazon identifier specimen passes built Chromium fill, separate commit and
replay denial at its recorded viewport. Four Chromium mutations (page cover,
hidden label, moved label, zero-opacity action) reject preparation, never click
and clear the synthetic write. Source hashes and results are recorded in
`form-corpus/2026-09-21-amazon-aria-action-replay.json`.

Concrete label and geometry REDs preceded production edits. Independent review
caught and re-reviewed the own-caption binding regression. Full unit2993:
2989 passed,4 existing Bilibili/Meczyki failures,0 skipped; typecheck passed.
This is identifier-stage synthetic support, not production authentication, a new
complete service or additional regional coverage.

## Meczyki and Bilibili custom actions

The unchanged login specimens reproduced two action-execution gaps. An explicit
`deferred-control-click` variant now uses the existing bounded shared action
classification, scope discovery and authorized fill/commit protocol. Meczyki's
non-navigating styled anchor and Bilibili's sibling DIV login action both pass
built Chromium replay at their recorded viewport. Bilibili uses only its recorded
nonempty-field activation response. No production login or server response is
inferred. Twelve Chromium mutations across the two specimens reject commit and
clear synthetic writes: changed href/role, class, caption, overlay, replacement
and an extra field. The shield check covers count and closed root, not geometry.

The two remaining unit failures were a harness contract error: it sent signup and
SMS-registration expectations to the existing-credential login adapter. Their
replacement tests assert rejection by that adapter. Original HTML/CSS and action
requirements remain unchanged; both browser rows explicitly remain
`unsupported-current-adapter`. A separate generated-secret registration/capture
executor and SMS source are missing capabilities. These are not successful
registration cases and do not satisfy the owner's complete-flow requirement.

Validation: 3023/3023 unit tests, no skips; typecheck; 9 existing agent Chromium
scenarios; both custom login replays and their 12 mutation checks passed. Read-only
independent review found no blocker in the extension diff. The matching native
change is separate; installed CLI and user extension were not replaced. Neither
CI/cloud review, release nor regional corpus completion is implied.

## Whole-corpus recorded-viewport baseline

The complete rebuilt Chromium replay at code e75a0b5 processed all 200 rows:
72/121 login screens passed; 49 failed (36 no-form, 8 challenge, 5 stale). All
200 expected shield-count/closed-root checks passed. The 77 registration specimens
and 2 non-auth negatives remain outside the live-login adapter. These are screen
replays, not successful account flows, user fill/capture or geometric acceptance.

`form-corpus/2026-09-21-recorded-viewport-baseline.json` contains every result,
code/harness identity and limitations. The older baseline's height2000 prevents
a direct comparison of totals. Disabled-action cases without recorded activation
still fail full replay despite their separate discovery-only assertions. Source
reductions, visibility, localized captions, challenges and extra account context
must be diagnosed separately; this PR remains draft and the goal incomplete.
