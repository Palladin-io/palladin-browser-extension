# Automatic user autofill policy

Status: intentional pre-production product decision for CVT-372, confirmed
2026-08-22. This policy is normative for classic user credential autofill.

## Decision

When Palladin is unlocked and the isolated content script detects the first
empty standard login form on an HTTPS page, it may immediately fill one
Credential without requiring focus, a click, or browser user activation. This is
the chosen password-manager UX, not a missing authorization check. Automatic
fill is always fill-only and never submits the form.

A content-script fill request never renews the session's idle deadline or its
shared-unlock authorization. The same channel includes passive automatic fills,
so it is not evidence of trusted user activity. The native extension surface's
separate trusted activity channel records own input with its original timestamp.
This preserves automatic exact-host autofill without adding a gesture gate.

Inline discovery uses the same credential-form analysis as native live login.
It accepts an unambiguous username/email stage, a current-password stage, or a
combined login stage, bound to one native form or one bounded credential scope.
An unrelated standalone email field is not a login stage. Registration, password
change, ambiguous actions and hidden or readonly controls remain excluded.

Open shadow roots attached after startup are discovered through bounded probes of
previously observed eligible hosts (at most 256 native property checks per 250 ms).
Idle probes do not traverse the document or read layout. A newly found root schedules
the normal throttled scan; closed roots stay inaccessible. Host references are weak,
and stopping the controller cancels its probes and clears the candidate list.

Requiring a blanket user gesture before every automatic exact-host fill changes
the product behavior and must not be introduced as a security fix without a new
explicit product decision.

## Canonical first-match algorithm

Candidates must be Credentials with a username and a stored domain that exactly
matches the normalized active HTTPS host. Related entries are excluded.

1. If an exact-host Credential was successfully filled earlier for this same
   exact host during the current unlocked service-worker session, promote it to
   the first position.
2. Otherwise use the deterministic exact-host order: Entry name ascending.
3. Fill the first exact-host candidate into the first detected empty standard
   login form once for the current URL.

The preference is held only in service-worker memory and is cleared on lock. It
must never be persisted because that would create a plaintext host-to-Entry
history outside the encrypted Vault.

## Non-negotiable gates

- top frame and browser-authored sender identity;
- HTTPS and exact normalized stored host;
- active tab and page-load/browser document binding, rechecked before decrypt
  and DOM write;
- an isolated-world target identity that binds the worker round-trip to the
  exact present username/password controls and owning scope discovered before decryption;
- Credential type, username, and stored domain present;
- rendered, non-zero-area, usable controls in the same detected credential scope;
- every present login control is still empty when the automatic suggestion response
  returns;
- one automatic fill per current URL/form lifecycle;
- `submit: false` for every automatic fill;
- no password, TOTP, notes, or custom-field values in suggestion responses,
  logs, analytics, or persistent storage.

A same-registrable-domain sibling is only a labelled related-site candidate. It
always requires a closed-surface, per-Entry choice for one operation, and the
final write is rebound to the exact live host. Cards, neutral custom fields,
form submission, capture, save, and update also remain explicit actions.

## Explicit manual choice

A click on a particular Entry in the closed inline surface sends a typed `manual`
intent through the authenticated worker/document channel. It may replace another
account already present in the bound controls. `automatic` intent never overwrites
existing values, never permits related-host selection and never submits. Missing
inline intent is rejected; legacy worker fill messages do not gain replacement rights.

Matching values are preserved without replaying input events. After each DOM write,
control ownership and both completed and not-yet-written values are rechecked.
Explicit “Fill and log in” consumes a one-use isolated-world receipt from that
approved fill, waits one task for framework state, then rechecks URL, scope, control
identity and approved values before submit. Each request has a one-use local
operation identity and a value snapshot captured before contacting the worker.
A new manual choice, session lock or widget removal invalidates earlier deliveries
and pending submits; a passive retry cannot replace an outstanding manual choice. The receipt is memory-only and expires
after five seconds. A formless scope requires exactly one enabled native credential
button; arbitrary page DIV actions are not clicked. Submission is not proof of
successful authentication.

## Accepted trust boundary

Filling a password into a page intentionally releases that value to the exact
stored origin, just as manual typing or another password manager would. Scripts
running on that accepted origin can observe values present in its DOM. Palladin
reduces phishing and confused-deputy risk by choosing the Entry itself and
enforcing the exact host/document gates; it does not claim that a saved origin's
own page scripts are unable to observe a password filled into that page.

Page content cannot name a Vault/Entry, broaden the domain, opt a related host
into automatic fill, trigger form submission, or bypass the worker and isolated-
world gates. Those are security boundaries. The absence of a focus/click
requirement for the canonical first exact-host fill is the documented UX choice.

## Implementation anchors

- `src/content/isolated/inline-autofill.ts` owns one-shot form discovery, empty-
  value protection, per-form target identities, first exact selection, and
  fill-only behavior.
- `src/content/isolated/fill.ts` revalidates that exact control pair immediately
  before each inline DOM write.
- `src/background/vault/inline-runtime.ts` owns exact-before-related ordering and
  the in-memory per-host recency preference.
- `src/background/vault/entry-metadata.ts` provides deterministic name ordering.
- `src/background/vault/commands.ts` repeats HTTPS, host, tab/document, type, and
  pre-decrypt/pre-write gates.

Tests must continue to cover automatic fill without focus/user activation,
preference promotion and lock reset, existing-value protection, no repeat fill,
related-host exclusion, and no automatic submit.
