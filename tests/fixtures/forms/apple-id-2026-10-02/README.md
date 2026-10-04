# Apple ID / App Store Connect identifier regression

Observed 2026-10-02 in the user's Chrome at the public, signed-out
`https://appstoreconnect.apple.com/login`, Polish locale. The direct child is
`https://idmsa.apple.com/appleauth/auth/signin`. Query parameters were omitted.
Installed extension: 0.1.3, main commit efb40a05b6fa9eb0bfc66d75f057a7fbfb99099c.
Chrome's exact version was not recorded.

The specimen was built from read-only DOM metadata: input types, IDs,
autocomplete, class/ancestor structure, button captions/state, and computed
password-wrapper CSS (`height: 0px; overflow: hidden`). There is no native
`form`. The child iframe has no sandbox attribute. Input values, hidden values,
cookies, storage, tokens and site scripts were not collected.

Reductions: omitted widget ancestors above the sign-in surface, Apple logo,
privacy prose/links and decorative spans; normalized whitespace and transient
focus classes. Span label text was retained; it is not a native label. Included
only the clipping CSS relevant to password visibility. The outer-frame test uses
the same Apple hostnames in an isolated synthetic Chromium profile, intercepting
every request locally (no Apple network traffic), and a visible 700px iframe. Browser tests add their own input listener to enable Continue and a
read-only carried-identifier/password stage and post-click challenge; those events are synthetic, not a capture of Apple code.

TDD evidence: before production changes, `apple-agent-login.test.ts` failed with
`expected undefined to deeply equal ['credential.username']`. The provider
regression separately failed because preparation returned `provider-unavailable`
instead of the selected credential document and plan.

Agent expectations: inspect only the identifier; native authorization must bind
the child host, then write once, report submit-ready without clicking, and require
a separate commit. Hidden, duplicate, replaced, navigated, foreign-domain and
stale documents must not receive values. The user adapter is checked with this same specimen and must remain identifier-only.
User autofill behavior is unchanged; this specimen does not establish password-stage support.

Validation: focused unit tests plus `npm run test:browser:agent-frames` exercise
real built Chromium content scripts and production frame routing, with synthetic
native authorization and values. `npm run test:browser:agent-live` covers existing
top-frame stages. This is not installed-browser Apple authentication acceptance:
that remains pending after review/build installation. The password transition
is synthetic on the observed structure; real password/2FA stages have not been
captured or claimed as verified.

Re-observed 2026-10-04 on the same public Polish identifier page: the native
Continue button is disabled with `pointer-events: none; opacity: 0.42`. These
computed styles were missing from the original reduction and are now included.
No input values or site scripts were read. Adding just these styles made the
built Chromium frame test fail at preparation (`provider-unavailable` instead
of `ready`) before the fix. The fixture now tests preparation before the button
becomes interactive. The synthetic input listener models enabling it; negative
cases keep it disabled or keep pointer events blocked after enabling and require
no submit-ready result, no click, and cleanup. Hidden/transparent action rejection
is covered separately. Installed-browser acceptance of this follow-up is pending.
