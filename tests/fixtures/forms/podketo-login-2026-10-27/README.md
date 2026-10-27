# Podketo login investigation (2026-10-27)

Public source: https://podketo.pl/pl/signin.html. Both `/login.php` and
`/pl/login.html` redirected here during anonymous Chromium inspection.
The homepage https://podketo.pl/ contains search/newsletter controls and links to
login, but no password control. The original anonymous capture entered no credentials. The follow-up live
investigation used only synthetic credentials and blocked login requests; see
[the evidence report](../../../evidence/podketo-2026-10-27.md).

`page.html` preserves the observed native form, input names/types/IDs, absent
`autocomplete`, associated Polish labels, wrappers, POST action and login button.
The loyalty-card alternatives are part of the observed labels, not added hints.
The hidden operation value and decorative SVG paths were removed. Scripts, page
shell, recovery form and production CSS were omitted. `home.html` retains the
observed search, login link and newsletter subtrees. The browser replays the
observed login destination locally using a synthetic `location.replace` instead
of an HTTP 302 (Chromium follows fulfilled HTTP redirects outside Playwright
routing). This prevents a redirected document from reaching the real server. The browser harness supplies synthetic
layout CSS and a submit counter, routes the exact host locally and blocks other
HTTPS requests. No production scripts run against synthetic credentials.

The live login pair was visible in the top document with nonzero geometry; its
ancestors had visible display/visibility and opacity 1. The unrelated Google
shopping iframe does not own the login controls. There is no login Shadow DOM.

## Result and limits

Baseline `e8dc3a2`: the current shared detector recognizes both controls on the
live anonymous DOM. The built worker + encrypted synthetic Vault + isolated
content script also automatically fill the observed specimen and display one
aligned shield without submission. **No failing detector assertion was found;
this is preventive coverage, not a claimed RED-to-GREEN production fix.** No
production logic or origin/unlock gates were changed.

User adapter: automatic pair fill and shield verified in Chromium; existing
identity is preserved. Synthetic negative variants cover hidden password,
new-password registration, OTP identifier and foreign form ownership. Agent
adapter: shared specimen discovery checked separately in jsdom; no real Agent
Inject or website authentication is claimed.

The follow-up live investigation established a separate navigation regression:
`Log in` from the storefront ignored a saved `/pl/signin.html` URL and opened
another storefront. The command regression now reproduces that observed
`no-form` result and verifies same-origin saved-path navigation. Field discovery
needed no change. See the evidence report for the release comparison, live matrix
and boundaries of the claim.
