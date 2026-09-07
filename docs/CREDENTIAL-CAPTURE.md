# Credential capture (CVT-373)

Implementation and browser acceptance are under final review. Shared-package
release 0.6.0 is published; this feature is not yet marked delivered.

## Product contract

The isolated content script captures submitted login, registration and password
change forms on HTTPS in the top frame. No main-world bridge message carries
captured credentials. The generated-password flow remains separate.

A right-side closed-shadow toast suggests a one-click Update for one exact
host/account match, otherwise Save in Personal. Registration defaults to Personal.
Change opens the optional target chooser; there are no editable text fields.
The popup settings reuse the existing SettingsSection and Button controls.

Design direction follows the existing extension: system font, 14px primary
copy/12px secondary copy, left-aligned content, brand red primary action, existing
light/dark palette (#EB4747, #F3F5F8, #FFFFFF, #0C0E12, #16161A, #E8EAED).
The only prominent action is the named write target; selectors are deferred.

```text
Palladin  Update your password?       ×
          example.com
[ ] Automatically update passwords for this account
[ Update Alice ]          Change...
Not now                   Don't ask for this site
```

The checkbox is off by default. An Update click can authorize later automatic
password changes for the same Entry. Automation requires one exact account,
a recognized positive success message, the matching previous password and the
stored Entry revision/origin binding. Other cases still require a user click.
Another client editing or repurposing the Entry invalidates the stored revision
binding; this prevents the opt-in silently carrying over to another account.

## Trust and lifetime

- Submit observation requires a recent trusted form interaction. DOM outcome
  signals are heuristics, not authenticated proof that a third-party server
  accepted a password. Visible errors suppress a proposal. A form disappearing
  or a same-origin navigation without a password form permits a manual proposal,
  not automatic mutation without a positive success signal.
- An observation can cross to the next browser-issued top-frame document on the
  same origin, bounded by the original three-minute lifetime. Other origins,
  tab close, lock/logout, dismissal and expiry discard the pending credentials.
- Pending values live only in worker memory and travel directly from the isolated
  content script. The toast receives target metadata, never passwords.
- Only metadata for muted sites and explicit account opt-ins persists in
  `palladin.capture-preferences.v1`. The store explicitly serializes opaque Entry
  and Vault IDs, revision and origin; no username, password, display label or key.
  Profiles are partitioned by authenticated API origin and account ID.
- Confirmation controls reuse the closed-surface construction used by autofill
  and the existing visibility/topmost check. Untrusted clicks, overlays and
  detached surfaces cannot activate a write. The worker independently checks
  the sender/frame, document, origin, session and target before writing.

## Canonical writes

The writer uses fresh encrypted Vault/Entry state and optimistic `baseRevision`.
Update changes only password; it preserves every other field, Agent visibility
policy and delivery policy. No vault move is performed. Writable-vault presentation uses
the VaultManage claim; the backend remains the authorization authority.

FULL uses the current versioned Vault key, with no per-entry envelope fan-out.
GRANULAR envelopes and dependent complete ScriptExecution packages are submitted
in the same canonical Entry mutation. Scope/material failures stop before the
write, and the final session/document authorization is repeated immediately
before the API request.

The successful mutation response acknowledges Save/Update immediately. The
best-effort metadata refresh continues separately; slow cache repair cannot
delay the success result, account opt-in persistence or wiping the write's owned
keys. A failed refresh never turns a confirmed mutation into a retryable write.

CVT-573 adds the Credential policy and grant builder to `@palladin/crypto` 0.6.0.
The manifest and lockfile pin the published registry release exactly. Clean
installs no longer depend on a local npm tarball or a feature-branch package.

Entry key-wrapper revision is independent of MemberSecret revision. A password
update creates a new Entry key version whose initial wrapper revision is 1;
sync still checks key version, generation, scope and authenticated envelopes.
Current Credential creation uses the additive shared discovery projection with
Get/Exec/Inject capabilities, matching the web producer.

The worker stages submissions before asynchronous session checks, so a fast
classic navigation cannot lose the pending capture or resurrect it after lock.
Live URL verification addresses the browser-issued document through the existing
isolated-world URL channel: `tabs.get().url` can be redacted under the current
manifest. No new permission is required. Only one same-origin successor document
is allowed within the original lifetime.

## Browser acceptance evidence

`npm run test:browser:capture` builds production Chromium into a disposable
profile and exercises real trusted mouse/keyboard input, the native action popup,
closed-shadow toast and real shared crypto. HTTPS test pages and a synthetic
in-memory provider isolate this from real accounts. The provider is not proof of
the deployed backend's authorization or database transaction implementation.

Passed: SPA/classic login, registration and password change; Personal default,
explicit Team selection; failed/identical-login suppression; default-off account
opt-in, later automatic update, disable in Settings; site mute/unmute and dismiss;
locked classic submission followed by native popup unlock and Save; existing
generator fill and explicit save. Ambiguous accounts default to Personal creation;
the chooser identifies an account and Vault, and updates only the selected Entry.
The last full run made 20 encrypted writes. HTTP, cross-origin iframe and
script-dispatched submits produce no capture; a page overlay cannot click through
the toast, and leaving/returning to an origin cannot resurrect pending values.
The storage check reads Chrome local/session storage and every IndexedDB store,
and finds none of the test passwords or tested Vault-key representations.

With synthetic active FULL and GRANULAR context, a rejected update preserves the
old Entry, explicit retry sends the next Entry plus one GRANULAR envelope and a
complete dependent ScriptExecution package. A
recipient-side decrypt verifies only the approved password, Inject method and
remaining-use binding. The Script package is independently opened with the Agent
key and trusted Vault signer and contains only its exact approved username and
password references at the new Entry revision. FULL receives no per-Entry fan-out.
Separately, 26 backend Entry/Script replacement integration tests passed against
isolated PostgreSQL on unchanged backend source. The broader 46-test selection
had one failure in concurrent grant consumption, not in the Entry transaction
tests; that broader suite is not reported as green. A preceding browser run timed
out on the first success toast while the full web unit suite was running; the
same assertions passed on the subsequent complete run. Keep this timing case
visible until the harness/runtime wait is understood.

Two deterministic create/update regressions subsequently reproduced a concrete
acknowledgement delay: a pending metadata refresh blocked an already successful
mutation result and key cleanup. The writer now starts that refresh without
awaiting it; both regressions passed after failing against the prior behavior.
The full extension tests and three build targets passed, followed by all 20
browser writes. This proves the stalled-refresh case is fixed, not that it was
the cause of either historical browser timeout.

A later run timed out on the next automatic update after a successful manual
update. Browser assertions now require both visibly checked consent and its
persisted exact Entry/revision/origin binding before proceeding. An explicit
checkbox aria-label prevents the decorative checkmark from changing its AX name.
The latest full 20-write run with crypto `1583104` passed alongside the web suite;
that alone is not proof of the original intermittent cause being eliminated.

## Acceptance remaining

- Complete the requested cloud Codex review loop for each scoped client repository.
- Keep the registry-pinned builds/tests and browser acceptance green on the final
  reviewed heads. Shared crypto 0.6.0 is published through signed-tag provenance;
  the older generic APIs retain their existing behavior.
