# Automatic user autofill policy

Status: intentional pre-production product decision for CVT-372, confirmed
2026-08-22. This policy is normative for classic user credential autofill.

## Decision

When Palladin is unlocked and the isolated content script detects the first
empty standard login form on an HTTPS page, it may immediately fill one
Credential without requiring focus, a click, or browser user activation. This is
the chosen password-manager UX, not a missing authorization check. Automatic
fill is always fill-only and never submits the form.

A standard login form must expose both a usable username/email control and a
usable password control associated with the same `form`. A standalone email or
username form never receives the inline launcher, suggestions, or automatic
fill.

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
- Credential type, username, and stored domain present;
- usable username/email and password controls associated with the same form;
- username and password controls are still empty when the suggestion response
  returns;
- one automatic fill per current URL/form lifecycle;
- `submit: false` for every automatic fill;
- no password, TOTP, notes, or custom-field values in suggestion responses,
  logs, analytics, or persistent storage.

A same-registrable-domain sibling is only a labelled related-site candidate. It
always requires a closed-surface, per-Entry choice for one operation, and the
final write is rebound to the exact live host. Cards, neutral custom fields,
form submission, capture, save, and update also remain explicit actions.

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
  value protection, first exact selection, and fill-only behavior.
- `src/background/vault/inline-runtime.ts` owns exact-before-related ordering and
  the in-memory per-host recency preference.
- `src/background/vault/entry-metadata.ts` provides deterministic name ordering.
- `src/background/vault/commands.ts` repeats HTTPS, host, tab/document, type, and
  pre-decrypt/pre-write gates.

Tests must continue to cover automatic fill without focus/user activation,
preference promotion and lock reset, existing-value protection, no repeat fill,
related-host exclusion, and no automatic submit.
