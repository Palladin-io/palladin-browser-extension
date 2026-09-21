# Shared production-form specimens

New form regressions used by multiple adapters belong here. Follow the
[TDD procedure](../../../docs/FORM-REGRESSION-TDD.md).

Each directory is a versioned observation, for example
`external-next-2026-09-15/`, containing:

- `case.json`: stable ID, issue reference, source public host/path (no query or
  fragment), observation date, locale/UI variant, observed vs hypothetical
  provenance, documented redactions/reductions, ordered steps and per-adapter
  expectations/support. Do not include account identity or page values.
- `page.html`: the faithful observed form structure, with synthetic data only.
- `page.css`: the styles needed to preserve layout/visibility, if applicable.
- `behavior.js`: locally authored reproduction of observed page transitions,
  if applicable. No third-party production bundle, network request or secret.

Preserve multiple page/step files when the defect depends on document replacement.
Mount the same files on synthetic HTTPS origins in the browser harness; do not
modify field structure depending on which adapter is under test. The adapter may
choose different actions and assert different allowed outcomes on the same page.
A unit regression may load the same markup through its test runner's file loader.

Recommended expectations for every supported adapter:

1. Which controls can be recognized and which must be excluded.
2. Which fields may receive synthetic values, and the allowed submit/advance.
3. What invalidates the document/control binding.
4. For capture: whether a prompt is expected, whether Save is required, and the
   expected encrypted Entry contents and selected Vault after confirmation.

An unavailable adapter is `unsupported`, not a passing test. The Playwright
provider currently remains disabled. Browser automation used to run a fixture
is not evidence that the production Playwright Inject provider works.

`production-form-corpus.test.ts` and `tests/browser/form-corpus.mjs` automatically
load these directories. Both use the same captured DOM/CSS. The Chromium runner
exercises the built extension with synthetic values; the native runtime and
backend are substituted. This is not yet a published cross-repository package.
Existing inline safety scenarios remain separate from production specimens.

`expected.agent.observedOnly` lists controls whose kind/purpose must be inspected
but which receive no fill assignment, for example an SMS verification code.
Chromium asserts that these and all other unassigned inputs remain unchanged.
For `stage: "verification"`, the unit scenario also populates a synthetic code and
checks that neither a Credential nor a staged account identifier is emitted.

For a separately tested explicit action, `expected.agent.action` identifies the
observed control. The current scenario covers a unique non-navigating anchor or
an observed div styled as an action:
fill must not click it, adding href invalidates the inspected snapshot, a fresh
inspection after restoring the element permits one click, and replay is rejected.
Its local counter measures activation only; no production submit handler is copied
and no successful authentication or account creation is inferred.

`actionActivation.kind: "nonempty-fields"` reproduces the separately observed
class/opacity response to the listed input events. Bilibili login keeps the
action disabled with only an account identifier, enables it with both fields,
and disables it again after clearing the password. The same test-only helper
is used by unit, Agent and capture replay. Production discovery never removes
the disabled class. This local behavior does not reproduce validation or submit.

For observed per-field activation, `activation.kind: "focus-removes-readonly"`
and an ordered `activation.selectors` array enable the shared activation scenario.
Keep the independently observed `initial.html` and `initial.css` alongside the
ordinary post-activation specimen. The unit test checks each intermediate state;
Chromium starts with no writable controls, clicks each actual field, checks the
new Agent inspection and rejects a transient user login launcher. The fixture
replays only the observed focus response. Do not claim that validation, navigation
or submission is reproduced unless those behaviors have separate evidence/tests.
Never remove readonly in production detection to make a fixture pass.

Production-observed false positives (for example newsletters) live in the sibling
`tests/fixtures/non-auth/` directory with `flow: "non-auth"`, `expected.user: null`
and `expected.capture: null`. The same two runners load them. The unit runner
also populates the observed controls and asserts that no identifier or credential
message is sent; Chromium asserts no user launcher while retaining explicit Agent
profile-field expectations. They never count toward regional authentication coverage.

`scripts/observe-public-form.mjs` captures a reviewed public subtree without editable
or hidden field values or executable page code. Input submit/button value attributes
are retained only as public action captions; button payload values remain omitted.
For anchors, an observed `href` becomes the fixed synthetic fragment
`#form-specimen-navigation`. Its absence stays absent. This preserves the
navigation-vs-action distinction without reading or retaining the target URL.
Do not infer original href presence in older specimens; re-observe affected pages
when a regression depends on that distinction.
Dates in the initial corpus use UTC. The recorded
computed CSS is a layout/visibility projection; page scripts, external shells and
unobserved transitions are not reproduced. Partial stages and cross-frame gaps
must remain explicit in `case.json`, even when the supported-control tests pass.
An `account-details` stage can contain a separate login and contact email without
a password. It is partial, and the runner asserts no credential or staged login
identifier message. `expected.capture.emailConfirmations` lists observed repeated
email selectors; the runner also mismatches them and requires capture rejection.

`coverage.json` tracks observations separately from live acceptance and regional
selection. `selection-sources.json` contains public ranking evidence: Semrush
country top 20 for all 32 agreed European markets, Similarweb global top 100 and
Ahrefs Polish top 100 by **organic search**, not total traffic. These are candidate
sources, not a completed selection of 100 tested services per region.
`regional-shortlists.json` records 100 provisional candidates per region, their
evidence and the exact selection method; it is not counted as passing coverage.

Integration on2026-09-21 adapts the historical corpus to current main. See
[the integration ledger](../../../docs/FORM-CORPUS-INTEGRATION.md) for counts
and unfinished gates. Existing case expectations remain requirements, not claims
that the current adapters already support every specimen.

The capture projection now preserves observed `method`, `enctype`, `formmethod`
and `formenctype` attributes. Earlier specimens omitted these; do not infer a
production GET method from their absent attributes or use them as evidence for
submit-transport safety. Re-observe affected forms when that distinction matters.
Action URLs remain excluded. RED/GREEN coverage of this projection change is a
synthetic helper contract, not a newly observed website.
