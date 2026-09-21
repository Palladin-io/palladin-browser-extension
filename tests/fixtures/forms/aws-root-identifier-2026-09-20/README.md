# Observed AWS Root identifier structure

Captured on 2026-09-20 from the public Root identifier screen at
`https://signin.aws.amazon.com/signin`, after selecting Root from the IAM screen.
The owner-controlled browser showed that ordinary Next reached the password
screen, while Palladin's prior `requestSubmit` caused an unintended default GET.

`page.html` preserves hierarchy, text, native button types, form ownership and
selected semantic attributes. Next is **type=submit**, not type=button. The form
has no explicit method/action. All input values and hrefs were omitted; classes,
styles, SVG, scripts, iframe and image nodes were removed. Computed display:none
is represented with hidden. No URL query, credentials, authenticated HTML or
production JavaScript is included.

The regression adds a **synthetic** click handler that prevents default and
advances the step. Separate synthetic cases cover onSubmit-based frameworks and
a handlerless form whose default GET would serialize credential fields. Browser
replay uses the real built extension with synthetic encrypted entries on reserved
test hosts. It proves event ordering and absence of default query navigation,
not production authentication or faithful AWS CSS/framework internals.
