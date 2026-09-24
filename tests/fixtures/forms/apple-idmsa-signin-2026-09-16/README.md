# Apple IDMSA sign-in specimen

The public `https://account.apple.com/sign-in` page was observed embedding
`https://idmsa.apple.com/appleauth/auth/authorize/signin` on 2026-09-16. The
reported direct `https://idmsa.apple.com/IDMSWebAuth/signin` flow embeds the
same-origin widget. `page.html` retains only the observed sign-in scope,
identifier/password IDs, field types/autocomplete and `hide-password` stage.
The button label and synthetic transition handler model the two stages; they
are not a copy of Apple's production script. Styling, query strings, account
values, cookies and authentication responses are excluded.

The browser regression exercises the built extension on both browser-routed
origins with a synthetic encrypted Credential. It checks the user shield and
worker-to-child fill. Agent Inject is outside this user-autofill regression.
Passing the fixture is not a real Apple account login; installed-artifact
acceptance with a test account remains a separate release gate.
