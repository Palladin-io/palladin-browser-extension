# Observed AWS root-user identifier step

Observed on the public AWS console sign-in page (`*.signin.aws.amazon.com/signin`,
root-user variant, English, Chromium) on 2026-11-22 without entering any value.
The native form, its controls, labels, autocomplete metadata and the Next submit
remain. Values, hidden inputs, scripts, SVGs, styles, class names, the legal
footer and all other non-structural attributes were removed; no query parameter,
cookie or account data is retained. CSS and production event handlers are absent.

Only this identifier step was observed. The password and MFA steps used with it
in tests are synthetic, because reaching them requires submitting an address to
the production service. They are not a reproduction of AWS server behavior and a
passing test is not real-site acceptance.
