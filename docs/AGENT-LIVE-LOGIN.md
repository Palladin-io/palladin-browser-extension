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

## Deferred identifier submit

A form may expose its native submit only after the identifier is entered. An
explicit live-only version-2 plan supports this initial stage for exactly one
`credential.username` field, never passwords, TOTP or mixed fields. It requires a
native form, one recognized editable identity, concrete credential context and no
challenge or ambiguity. A public Continue caption is an intent hint, never an
executable DIV or an invented button.

The additive frozen wire example is `tests/fixtures/protocol/deferred-live-v2.json`:

1. `prepare` returns version 2 with `deferred-native-click`; its opaque selector
   binds a scope, not an existing action. Saved version-1 maps are unchanged.
2. An authorized `inject` includes `expiresAt` and writes the identifier at most
   once. It can wait up to five seconds to observe one enabled native action in
   the original form. It returns `submit-ready` with `pendingId`, current URL,
   document ID and the actual bound action reference. Nothing has been clicked.
3. Native rechecks the original delivery, lease and lifecycle, then sends a new
   value-free `submit` transaction with `preparedTransactionId`, the same
   grant/Entry/domain, echoed `submitReady`, and the reauthorized `expiresAt`.
4. The extension consumes the pending operation before a synchronous final
   identity/control/scope/origin/destination/deadline check and one click. Only
   this phase returns `injected` and advances the normal continuation counter.

A pending operation has one original deadline, capped at ten seconds by both
wall time and `performance.now()`, and by the initial native expiry. Ready and
commit messages cannot refresh it. The reauthorized commit expiry is also
checked immediately before clicking, without an asynchronous wait. A native
`cancel-submit`, connection/lifecycle loss, timeout, new preparation or invalid
commit clears pending state. A late result cannot restore a disposed operation.
Only the approved identifier remains in isolated-world memory for equality
checking; nothing is persisted or emitted in the value-free ready/commit frames.
A matching prefilled identity is preserved without input/change events. Failure
clears a value written by this operation only while it still matches, preserving
later user edits. Replay, replaced controls, changed identity, new CAPTCHA,
foreign destinations, expiry and ambiguous actions all stop without a click.

Opaque iframe contents and arbitrary DIV actions are not operated. If no real
native action appears, this path stops instead of claiming a successful submit.
The browser regression demonstrates synthetic deferred behavior and does not
claim that X necessarily produces such a button after input.
