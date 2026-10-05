# Tomojdom login specimen (CVT-674)

Public source: https://tomojdom.pl/en/, observed 2026-10-04 in fresh headless
Chromium, English initial login. The installed extension and tab-script revision
reported by the user were not established.

`page.html` preserves the first public `#modules > .tmd-area` subtree, including
recovery controls, action captions and visibility classes. Input value attributes
were removed without reading their contents and the datalist was emptied. Only
the enclosing `#modules` wrapper is retained above the panel. The cookie notice,
external scripts, application shell and decorative CSS are omitted; `page.css`
retains the observed Bootstrap `d-none` rule. No authenticated DOM, cookies,
storage, HAR or real credentials were collected.

The tests explicitly reveal the existing password wrapper to model the next
stage. This is a synthetic transition, not execution of the production account
lookup or proof of the site's password/email-code selection. Browser tests add
synthetic field dimensions and click counters, with all requests served locally.

## Evidence and boundaries

- Baseline `a0ac08f`: `npx vitest run src/content/isolated/tomojdom-login.test.ts`
  failed 7 assertions before production changes, including absent initial target,
  absent launcher and popup `no-form`. The original dirty working tree also
  failed, but is not the PR base.
- The same regression passes after the exact-origin target adapter and popup
  routing change. Tests cover automatic identifier fill once, explicit
  same-account password fill, hidden recovery controls, replacement/ambiguity,
  HTTP/other origins and final document/origin binding.
- Codex round 1 reproduced two additional RED assertions: moving the identifier
  or password target into another same-origin iframe Document still allowed a
  write. Targets now retain the source Document and reject adopted controls;
  the bound fill also rejects a fresh foreign-document target. This is a
  synthetic DOM-adoption regression, not an observed action by the website.
- User adapter: initial identifier-only target; password target carries the
  existing account identity. A prior successful automatic identifier fill can authorize one bound same-entry continuation; otherwise the password step is explicit-only. No automatic action click.
- Agent adapter: no new Agent execution support is claimed by these tests;
  this specimen is shared for separate Agent inspection/acceptance.
- Chromium: `npm run test:browser:inline` uses the built extension, encrypted
  synthetic Vault data and this specimen. It checks field writes, one aligned
  launcher on each stage, explicit password selection and zero login clicks.
- Live-site observation and synthetic tests are separate. No real account login,
  email delivery, password validation or production authentication was attempted.


## Follow-up: explicit password login

The user reported a visible password field and the inline “The login form could
not be filled” error after choosing Log in. A test using this specimen reproduces
failed submit after a successful password write: the generic action scope is the
inner password block, while the adapter retains the outer panel. The local fix
binds explicit submission to the single enabled login button in that password
block; missing, duplicate, disabled and moved actions are rejected. This explains
a submit error in the specimen, but does not yet prove why the user observed an
empty password on the real page. A subsequent user request adds a memory-only, one-use continuation from a successful automatic identifier fill to the same account and panel. Synthetic stage tests cover the continuation and rejection of changed bindings, account, URL, session and pre-existing identifiers.
The browser regression includes the explicit action with fake data. An earlier
sandbox blocked startup; after access changed, Chromium passed both the bound
automatic continuation and explicit Polish password-submit scenario.

## Polish password-submit caption follow-up

On 2026-10-04 the parent agent observed the native button in the user's Chrome
accessibility tree as `Zaloguj hasłem` followed by the unlock glyph (U+F09C).
The reported explicit Palladin login action filled the password but returned
`The login form could not be filled.` The exact action vocabulary lacked
`zaloguj hasłem`.

The unit regression replaces only the captured English button's text node with
those observed Polish words, retaining the original empty Font Awesome icon
markup. This is a caption adaptation of the English specimen, not a complete
capture of Polish DOM/CSS; accessibility output does not establish whether the
glyph is DOM text or CSS-generated content. No account data was copied.

Before the one-label change, `submitFilledLoginTarget` returned false after a
successful manual fill for this caption. The same case now succeeds, while
captions with negation, extra account-creation text or alternative-provider
suffixes remain rejected. The exact-match vocabulary was extended without
changing visibility, form ownership, target binding, uniqueness or submit gates.
