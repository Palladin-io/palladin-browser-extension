# Capture lab

A static website that triggers **real extension surfaces**, not mock dialogs. All
values are disposable. The page has no backend, analytics, storage or form-value
transmission. Saving in Palladin still writes to the selected Vault: use a test
Vault, never real credentials or cards.

## Hosted page

[Open the deployed capture lab](https://palladin-capture-lab.netlify.app).

Publish only `site/` to an HTTPS static host. On Netlify, deploy this directory
as the publish directory; `_headers` blocks form submission/network connections
and disables indexing. Do not enable Netlify Forms or inject analytics/scripts.
The page works with an already installed and unlocked extension. Plain HTTP is
not a valid capture acceptance environment.

Each tab starts a new document, so dismissed captures can be exercised again.
The restart link reloads the current scenario. Muting a site is different: undo
that setting in the extension before repeating. Pending captures expire.

| Scenario | Trigger | Expected surface / prerequisite |
|---|---|---|
| Save login | Type username/password, submit | Save login; unchanged saved credentials should not duplicate |
| Update password | Save login first; same username, old/new password, submit | Matching entry update; test automatic update separately |
| Payment card | Type name, expiry and CVC first, number last; blur | Brand/card summary and native review with CVC; same PAN can update |
| API key | Click Generate API key | Generated-key capture, editable name/URL/additional fields |
| Strong password | Focus new-password input, open Palladin control | Inline generator, options, refresh, fill; submit separately |
| Authenticator | Reveal setup link or QR | Matching login first; create only without a match; replacement confirmation |
| Embedded card | Fill payment frame | Top-level notice, fields bound to payment document |
| Login method | Isolated launcher only | Provider choice, existing-entry autocomplete, cancellation suppression |

For each capture check Review, additional fields, Vault selection, Save, Dismiss,
site muting, and opening the resulting entry. The page cannot report that a Vault
write succeeded; verify inside Palladin. To exercise manual QR scanning, reveal
QR, open an existing login's detail in the extension and choose its scan action.

## Isolated browser and OAuth

From the extension repository, with Node 22+:

```sh
npm ci
npx playwright install chromium
npm run lab:capture
```

The launcher builds the current branch, opens a disposable Chromium profile,
configures the existing synthetic encrypted API fixture and unlocks a test Vault.
It routes `https://capture.example.test`, its payment frame, and the exact Google
and GitHub authorization pages locally. All other page HTTP(S) requests except
the ephemeral API are aborted. No real OAuth account or provider is contacted.
The synthetic origin exists **only inside that browser**. Close the browser or
press Ctrl+C to remove the disposable profile and discard the in-memory Vault.
The helper temporarily grants the loopback API origin only in its copied build;
it does not change production permissions, HTTPS checks or sender validation.

The hosted OAuth buttons intentionally stay disabled. Do not turn them into real
provider links with fabricated client IDs. The static site alone cannot reproduce
browser-authored provider navigation on another origin.

```sh
npm run test:browser:capture-lab
```

This exercises the static page and all eight scenarios through the actual
Chromium extension, including an explicit encrypted login save, matching password
update, inline generator and a cancellation negative case. After an authorized
publication, validate the hosted page with the disposable extension as well:

```sh
node tests/manual/capture-lab/run.mjs --smoke --site=https://YOUR-LAB-HOST
```

The hosted pass skips OAuth and uses the deployed headers/assets. It saves only
the fictional login into the disposable API, never your real Vault.

This exercises the lab through the actual Chromium extension. Firefox and Safari
require separate manual runtime checks; federated capture currently requires
browser document identity unavailable in those adapters. See
[`docs/BROWSER-COMPATIBILITY.md`](../../../docs/BROWSER-COMPATIBILITY.md).

Fixtures are synthetic reductions, not Booking reproductions. The QR is copied
from `tests/browser/fixtures/totp-setup-original.png` and encodes the public seed
`JBSWY3DPEHPK3PXP` for `Synthetic:alice`. Never use it for a real account.
