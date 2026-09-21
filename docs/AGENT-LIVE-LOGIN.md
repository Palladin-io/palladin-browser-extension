# Bound live login steps

An authorized native runtime can inspect and complete a supported login without
a saved selector map. The extension recognizes username, password and
authenticator-code stages from public DOM metadata. It returns opaque references,
never values or arbitrary page text. This path requires the authenticated native
provider; it is separate from automatic user autofill.

`prepare` opts in with `liveDetection: true` and an exact tab/URL. Its result
contains a one-step `liveForm`. Each authorized `inject` can request
`continueLive: true`. After the physical submit completes, `inject.result` has
`outcome: "injected"` and a value-free `continuation`:

- `ready`: `currentUrl`, `documentId`, `liveForm`; a fresh prepared step is retained
  on the same native connection.
- `challenge`, `no-form`, `timeout`, `origin-mismatch`, `insecure-origin`, or
  `provider-unavailable`: stop the chain without another write.

`no-form` means only two seconds of stable absence of supported login controls.
It does not prove authentication. Unknown screens, CAPTCHA, SMS/recovery codes,
framed forms and unsupported widgets are not automated. A cross-origin redirect,
including a sibling host after login, stops continuation and releases no further
values. The caller may separately verify its public destination.

Live login evaluates unsupported editable widgets within its selected native
credential scope. Advertising frames and unrelated custom controls elsewhere do
not invalidate a complete, unambiguous top-frame plan. An alternative iframe
beside native login controls is never inspected, filled or clicked. Recognizable
CAPTCHA/challenge markers remain blocking, as do covered controls, an incomplete
plan or competing native credential forms. This is not a claim about opaque
frame contents; a required verification step remains the website's responsibility
and is not bypassed. The generic registry retains its global obstacle report.

After posting its own encrypted terminal injection result, the extension permits
one immediate connection to a fresh idle native host when that session closes.
The old prepared operation and channel material are discarded first. A new frame
invalidates this permission; a new host starts without it. Failed posts, unknown
disconnects and subsequent connection failures keep the existing alarm backoff.
No old injection or value is replayed. This removes the normal 30-second host
reconnect delay between completed CLI operations without creating a retry loop.

The chain binds the original exact HTTPS origin, tab, grant, Entry and runtime
domain. It expires 60 seconds after the first authorized injection and permits
at most eight physical steps. Each transition waits at most ten seconds.
Every step uses a fresh transaction and DOM handles; successful submits are never
retried automatically. Native lifecycle loss discards the continuation. Values
are wiped after injection and never persisted.

A next stage must request a new field. A repeated username is accepted only
alongside a new password: the runtime supplies the same approved username for
local equality checking. A matching populated identity is preserved without
input/change events; an empty or different identity blocks submission. The equality is checked
again immediately before submit, including changes made by page input handlers.
Password and authenticator-code stages cannot be repeated within one chain.
The runtime owns grant authorization and fresh TOTP generation; the extension
receives only the code for the current step, never its seed.

Form references bind actual controls, field meaning, constraints and submission
destination. Replacement, covering, meaning changes, expiry or another document
invalidate them. React-style value reflection and unrelated DOM updates do not
invalidate unchanged controls. Agent-managed fields are excluded from ordinary
credential capture. Failed attempts remove only their newly added Agent marks,
so later manual input remains eligible for capture. Controls in open shadow roots
also bind the composed form owner and its submission destination and target.

## Evidence

The shared AWS root identifier fixture preserves the observed public native form
and recorded visibility CSS. Its later password/TOTP transitions in tests are
explicitly synthetic, not reconstructed AWS account screens.

The Allegro regression preserves a sanitized observed auth-form subtree plus a
separately observed advertising frame outside it. Its omitted ancestor layout
and production handlers are documented with the fixture. Submission handlers
and overlay/CAPTCHA tests are synthetic. The observed initial X form is also retained with its original unannotated DIV
action. Its later native-button transition in tests is synthetic; no production
post-input transition is claimed from that fixture.

Unit tests cover SPA and document changes, one native session, value-free
inspection, grant/Entry/domain changes, expiry, replay, tab replacement,
challenges, unchanged stages and carried identity. The continuation assertions
first failed because the old provider rejected the new request. A separate
failing identity-mutation test demonstrated the need for the final equality check.

`npm run test:browser:agent-live` builds into a temporary Chromium profile and
checks the observed identifier plus generic combined login, carried username,
password-only, authenticator, navigation, replay and challenge scenarios. It
does not modify an installed extension or perform real authentication.

## Deferred credential submit

Live username and password stages use one version-2 preparation/commit path.
The existing normal-login discovery first binds its actual controls and native
action, including supported form-less DIV scopes. An adapter preserves that
classification, exact nodes, field modes and original snapshot lifetime while
separating writes from submission. Authenticator-code stages keep the immediate
version-1 path; saved version-1 maps are unchanged.

When no native action exists yet, bounded discovery supports a native form with
one recognized username or one enabled `type=password` control explicitly marked
`autocomplete=current-password`. It rejects registration, new-password, OTP,
extra editable fields, challenges and ambiguous forms. A password stage may also
show one disabled or readonly identity: it must already exactly match the
runtime-approved username and is never written. A public Continue caption is
only an intent hint, never an executable DIV or invented button.

Allowed version-2 field lists are exactly username, password, or username followed
by password. The mixed form does not itself grant permission to overwrite an
identity: the DOM snapshot freezes each field's writable or comparison-only mode.
An initially writable username/password form may fill both empty fields once.
Matching existing values are preserved without input/change events. On a later
password stage, the worker additionally requires any carried username to match
an existing value even if the page leaves that control writable. Password and
TOTP stages cannot repeat, and each continuation still requires a new field.

Frozen wire examples are `tests/fixtures/protocol/deferred-live-v2.json` and
`tests/fixtures/protocol/deferred-password-v2.json`:

1. `prepare` or a fresh continuation returns version 2 with
   `deferred-native-click`; its opaque selector binds the scope.
2. An authorized `inject` includes `expiresAt` and fills each writable field at
   most once, checking unchanged controls and earlier writes before the next.
   Preparation yields one event-loop task so already queued input handlers can
   update framework state. It then waits at most five seconds for one actual
   enabled native action in the same scope. `submit-ready` returns only the
   pending ID, URL, document ID and actual action reference. No click has occurred.
3. Native rechecks the original delivery, lease and lifecycle, then sends a new
   value-free `submit` transaction with `preparedTransactionId`, the same
   grant/Entry/domain, echoed `submitReady` and reauthorized `expiresAt`.
4. The extension consumes the pending operation before its synchronous final
   identity/control/mode/scope/origin/destination/deadline validation and one click.
   It re-runs the normal discovery core for adapter plans without creating a new
   authorization or refreshing the original lifetime. Only this phase returns
   `injected` and advances the continuation counter. No page wait follows the
   final native authorization.

Pending lifetime is capped at ten seconds using both wall time and
`performance.now()`, and by the initial native expiry. Ready and commit cannot
refresh it. Cancel, connection/lifecycle loss, timeout, new preparation or invalid
commit discards pending state. A late result cannot restore it. Expected values
remain only in isolated-world memory while pending, never in ready/commit frames
or persistent storage. Received field-value references are cleared when the fill
message completes. Failure clears only values actually written by this operation
that still match, preserving later user edits and pre-existing values.

The observed X password fixture preserves its native form, disabled username,
current-password control, unannotated Continue structure and visibility CSS.
Its outer page/search form and resource/value attributes were omitted; this is
not a full-page replay. Post-password-input native-button behavior is synthetic.
The framework-state tests reproduce queued microtask/timer updates on native
forms and DIV scopes; they are mechanism regressions, not captured LinkedIn HTML
or production JavaScript. All physical submits require a newly authorized commit;
no second-click retry or arbitrary DIV operation is added.


### Initial stage after user autofill

An explicit agent delivery can replace an unchanged tuple written by Palladin's
previous automatic user fill, using the one-use isolated provenance described in
[AUTOFILL-POLICY.md](AUTOFILL-POLICY.md#explicit-agent-choice-after-automatic-user-fill).
The private worker-to-isolated deferred-fill message carries an optional current
unlocked-session marker only on chain step zero and never with a carried-identity
requirement. This is not a public/native protocol field, a new grant right, or a
generic overwrite flag. Later stages, manual/pre-existing values, edited controls
and expired/invalidated receipts remain fail-closed. The original native delivery,
lease and one-call deadline are unchanged; submit still requires a separate fresh
native commit authorization.
