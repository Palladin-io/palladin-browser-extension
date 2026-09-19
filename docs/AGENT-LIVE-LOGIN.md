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

Unit tests cover SPA and document changes, one native session, value-free
inspection, grant/Entry/domain changes, expiry, replay, tab replacement,
challenges, unchanged stages and carried identity. The continuation assertions
first failed because the old provider rejected the new request. A separate
failing identity-mutation test demonstrated the need for the final equality check.

`npm run test:browser:agent-live` builds into a temporary Chromium profile and
checks the observed identifier plus generic combined login, carried username,
password-only, authenticator, navigation, replay and challenge scenarios. It
does not modify an installed extension or perform real authentication.
