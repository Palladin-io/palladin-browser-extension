# Apple Account identifier step: Continue enabled after fill

Observed 2026-11-23 in an isolated Playwright Chromium profile at the public,
signed-out `https://account.apple.com/sign-in`, English locale. The sign-in
surface is the child `https://idmsa.apple.com/appleauth/auth/authorize/signin`.
Query parameters were omitted. No account, password, cookies, storage or tokens
were used or collected.

Reported symptom: choosing an Entry with "Log in" in the inline menu wrote the
identifier, then showed "The login form could not be filled." and did not
continue.

Specimen: `#sign_in_form` outerHTML of the identifier step with input values
removed. Reductions: Apple privacy prose/links, Angular-style `($click)` /
`($focus)` attributes, inline `min-height`, transient focus classes and
whitespace. There is no native `form`. `#sign-in` has no `type` attribute
(native default `submit`) and is `disabled` while the identifier is empty. The
second action is "Sign in with Passkey".

Observed event sequence (value setter + `input`/`change`, the same write as the
extension): `account-name-entered` is added synchronously; `hide-password`
stays; `#sign-in` stays disabled synchronously, after a microtask, after
`setTimeout(0)` and after a further 16 ms, and is enabled when re-checked after
a further 50 ms. The same button node is kept. The test models only that delayed
enablement with its own listener; Apple scripts are not run.

`password.html` is the real password step reached after Continue with a
fictional `example.com` identifier (no password submitted), with the same
reductions plus the "Forgot password?" link text normalized: `show-password`,
one enabled `Sign In` button without `type`, and a password write keeps the same
controls, identifier value and classes.

In both steps the nearest credential scope of `#sign-in` is the inner wrapper
`div` that holds both inputs and actions, not `#sign_in_form` chosen by the
Apple detector. The earlier flat synthetic fixture hid that difference.

Fixture RED/GREEN and real-site acceptance are reported separately in the PR.
