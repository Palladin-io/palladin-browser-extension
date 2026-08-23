# Local testing

This runbook verifies the development extension without treating it as a
production release. Use a disposable Palladin account, dummy credentials, a
test card number, and a login page that you control. Never use a real password,
payment card, CVV/CVC, or PIN.

## What can be tested

| Flow | Local status |
|---|---|
| Sign-in, unlock, lock, and sign-out | Chromium development build |
| Automatic exact-host and user-selected credential autofill | Chromium development build on a controlled HTTPS page |
| Generated-password Fill then explicit Save | Chromium development build on a controlled HTTPS page |
| Manual Login, API key, Script, and Card creation | Chromium development build with dummy data |
| Card user-selected autofill | Chromium development build with dummy card data |
| Agent Inject through Native Messaging | macOS, Google Chrome, and the source-built Rust CLI only |
| Firefox and Safari packaging | Build validation only; installed-browser parity is not claimed |

The native Agent route does not support Chromium, Brave, Edge, Opera, Firefox,
Safari, Windows, or Linux yet. Those combinations must fail closed.

## 1. Prerequisites

- Node.js 22 or newer and npm.
- A compatible local or staging Palladin API and a disposable test account.
- Google Chrome for the full Native Messaging test.
- macOS and Rust 1.97 for the Agent Inject test.
- A controlled HTTPS login form. Autofill and password capture intentionally
  reject insecure pages.

If the selected/default Vault has an active `FULL` grant, new entry saves
currently return `grant-refresh-required`. Updating an existing
credential is likewise blocked by an active covering grant. Use a disposable
Vault without active grants for the successful write-path test; do not weaken
the grant policy to make the test pass.

## 2. Build the Chromium artifact

From this repository:

```bash
npm ci
npm run build:chromium
```

The default API is `https://api.palladin.io`; the default web-panel deep link is
`http://localhost:5173` until production packaging sets `VITE_WEB_APP_URL`.
For local testing, open **Settings** in the popup and set the server to
`http://localhost:5000`. The extension allows plaintext HTTP only for
`localhost` and `127.0.0.1`; custom remote servers must use HTTPS. Changing the
server signs out the current session and clears the local encrypted cache.

You can still set a public build-time default for staging packaging:

```bash
VITE_API_URL=https://api.stage.palladin.io \
VITE_WEB_APP_URL=https://stage.palladin.io \
npm run build:chromium
```

Do not place a password, API key, access token, or private key in a `VITE_*`
variable. Vite values are bundled into the extension and are public.

## 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository's `dist/chromium/`
   directory.
4. Confirm that Chrome shows the Palladin logo in the extension card and popup.
5. Confirm the extension ID is exactly
   `hmljnknogdeonphikmeofcbkikmpokba`.

Stop if the ID differs. The authenticated native host allowlist is pinned to
`chrome-extension://hmljnknogdeonphikmeofcbkikmpokba/`; changing or bypassing
that identity is not a valid test.

After rebuilding, use the extension card's **Reload** button and refresh the
test page so its content scripts come from the current artifact.

If Reload does not show the current popup, remove the unpacked extension and
load the exact `dist/chromium/` directory produced by the build above. Reload
never changes the source directory originally selected in Chrome.

For an HTTPS self-hosted server, open **Settings**, enter the API base URL, and
approve the browser's exact-origin permission prompt. The server must accept the
extension origin in its CORS policy. Denying or revoking that permission leaves
the server unchanged or unreachable; the extension never widens access silently.

## 4. Sign in and test the session lifecycle

1. Open the Palladin popup and sign in with the disposable account.
2. Complete TOTP if the test account requires it.
3. Confirm the Vault list loads and no secret is printed in the extension
   service-worker console or the page console.
4. Click **Lock**. Reopen the popup and confirm an unlock is required.
5. Unlock, then use Chrome's extension **Reload** action. Reopen Palladin and
   confirm the same account returns as **Locked**, never **Unlocked**.
6. Unlock again with the master password, click **Sign out**, reload once more,
   and confirm Palladin remains on **Sign in**.

A compatible MV3 worker restart, explicit **Reload**, disable/enable, browser
restart, or update restores only the password-sealed authentication envelope.
Bearer tokens must remain ciphertext and keys must never appear in browser
storage, so the only valid restored state is **Locked**. A wrong password keeps
the valid envelope for another attempt. Foreign server/runtime bindings,
expiry, and verifiable ciphertext/AAD tamper purge it. Some tampering of the
KDF or wrapped-key context is intentionally indistinguishable from a wrong
password and remains fail-closed locked until local **Sign out** clears it.
Signing out while already locked is authoritative locally; it cannot claim to
revoke the encrypted remote refresh token without first unlocking it.

## 5. Test user credential autofill

Create a disposable Credential entry in Palladin whose `urlDomain` is the exact
hostname of the controlled HTTPS test page. The page should contain unambiguous
standard controls, for example:

```html
<input type="email" autocomplete="username">
<input type="password" autocomplete="current-password">
<button type="submit">Sign in</button>
```

Then:

1. Open the controlled HTTPS page in the active tab.
2. Before focusing or clicking anything, confirm the first exact-host username
   and password fill once without submitting. Existing username/password values
   must not be overwritten. Confirm exactly one Palladin shield appears beside
   the username/email field (not beside the password) and opens a suggestion menu
   containing only the matching entry name, username, hostname, and Vault name.
   Confirm it uses the packaged Palladin icon rather than a separately drawn
   lookalike.
3. With multiple exact-host matches and no in-session preference, confirm the
   alphabetically first Entry name fills. Explicitly select another username,
   reload the same exact host, and confirm that account is now preferred until
   Palladin locks. After lock/unlock the non-persistent preference must be gone.
   Programmatic focus or a passive retry must not cause a second fill. Confirm
   the account body fills
   without submitting, while the separate
   enter-arrow action fills and submits the exact owning form.
4. Open Palladin, expand the same Credential, and click **Log in**. On the exact
   login page it must fill and submit the current form without opening a
   duplicate tab.
5. Confirm only the expected username and password controls receive the dummy
   values.
6. Navigate to a form containing only an email or username field, including one
   marked `autocomplete="email"` or `autocomplete="username"`. Confirm that no
   Palladin launcher or suggestion appears.
7. Navigate the same tab to a different hostname and retry. The suggestion must
   not appear and a stale selection/fill must be rejected.
8. Reload the extension, then refresh the login page before testing the new
   content script. Unlock the restored account; it must never restore directly
   to the unlocked state.
9. On a sibling host of the same registrable domain (for example `konto.wp.pl`
   with an Entry stored for `1login.wp.pl`), confirm the Entry is labelled as a
   related site and is never auto-selected. Click that exact account to grant a
   one-operation fill and confirm the final write targets only the current live
   host. A different registrable domain must never appear or fill.
10. Hide the login pair with page CSS, zero-area geometry, a disabled fieldset,
    and a closed dialog. Confirm no launcher or automatic fill occurs. Restore
    each state, including through a responsive viewport breakpoint, and confirm
    discovery resumes. While a fill is pending, hide or reassociate the username
    control and confirm the password is not written to that or another form.

When Palladin is locked or signed out, use the inline **Open Palladin** action
and confirm the browser-owned side panel opens on the unlock/sign-in surface.

The inline menu is extension-owned closed Shadow DOM. It may show the username
needed to distinguish accounts, but must not copy a password, TOTP seed, notes,
or custom value into its markup, page events, logs, or accessibility labels. The
visited site cannot request or auto-select a credential.

Alternatively, expand the Credential in the full Vault list and click
**Log in** from another page. The extension opens `https://{urlDomain}/`, waits
for the final live top-frame document, fills that exact document, and submits
the form that owns the password field. If the active exact-host page already
contains a login form, it fills and submits in place instead. It does not decrypt
before the HTTPS host is bound. The explicit **Log in** click is the submit
authorization; ordinary Fill and automatic exact-host fill remain fill-only. If
the site redirects to another host, delivery is rejected. Confirm **Open in
Palladin** opens the exact Vault/Entry detail deep link.

The extension may choose only the canonical first exact-host Credential when an
empty standard form appears; page content cannot name an Entry, widen the host,
force a repeat, or authorize submit.

### Test the persistent Vault surface

1. While unlocked in Chromium, choose **Open side panel** in the popup footer.
   Confirm Chrome opens Palladin in its browser-owned right-hand side panel.
2. Confirm the panel shows the same entries, language, theme, lock state and
   Settings as the popup. The header/navigation/footer must remain stable and
   the active list or form must own the only scroll region.
3. Confirm repeated hosts appear once with a login count and no aggregate Vault
   count. Expand a host and verify each account is identified by username and
   Vault; collapsing it removes those usernames from the rendered tree.
4. Change the active tab. Confirm exact-host entries refresh without closing the
   panel and without unlocking or filling automatically.
5. Leave the unlocked side panel open for longer than Chrome's normal worker
   idle window and confirm it remains unlocked. This heartbeat must not extend
   the configured auto-lock policy.
6. Lock or sign out from either surface. Confirm the other surface updates to
   the same coarse state without displaying or transporting a secret.
7. Scroll a large Vault to the end of the current batch. Confirm the next 100
   grouped rows append automatically; the accessible Show more fallback remains
   usable with a keyboard.
8. In Firefox, repeat with the native sidebar. Safari intentionally has no
   side-panel control in this development foundation and retains the popup.

Inline suggestions and Fill must continue to work when the side panel is
closed; opening the panel is never a prerequisite for autofill.

## 6. Test generated-password capture and save

Use a controlled HTTPS registration form with one or two visible fields marked
`autocomplete="new-password"`. A password-change form may additionally contain
exactly one `autocomplete="current-password"` field. Ambiguous or unlabelled
password fields are intentionally ignored.

1. Open the form, then open the Palladin popup.
2. In the capture prompt choose the strong-password flow.
3. Click **Fill** and confirm the generated value appears only in the
   `new-password` controls.
4. Confirm the popup now offers **Save to Palladin**.
5. Click **Save to Palladin** and verify the entry appears after refresh.
6. Repeat on a password-change form for a hostname with one matching
   Credential. Confirm the existing entry is updated instead of creating an
   ambiguous duplicate.

Fill and Save are deliberately separate actions. Closing the popup after Fill
but before Save must not persist the generated value.
The current capture path does not silently read or auto-save a password typed by
the page/user. It saves only the generated value after the user accepts both
Fill and Save; a future standard post-submit save prompt needs a separately
reviewed capture flow.

## 7. Test manual Add entry and card autofill

Use dummy values only. A suitable non-production test number is Visa's common
test value `4111111111111111`; it is not a real payment card.

1. In the popup choose **Add entry**. Confirm the type selector offers Login,
   API key, Script, and Payment card.
2. Add text, multiline, and concealed custom fields to a disposable entry,
   reorder them with the up/down controls, then save one disposable entry of
   each type. Confirm the saved field order and values are preserved, every entry appears in the
   Vault list and no plaintext is logged or persisted by the popup.
3. For Payment card, use a dummy label, cardholder, card number, future expiry,
   and optional billing address.
4. Open a controlled HTTPS checkout form containing `cc-name`, `cc-number`,
   `cc-exp-month`, `cc-exp-year`, and a separate `cc-csc` input.
5. Expand the card entry and click **Fill**.
6. Confirm cardholder, PAN, expiry, and supported billing controls are filled.
7. Confirm the `cc-csc`/CVV/CVC and PIN controls remain empty.

There is no dedicated CVV/CVC or PIN field, capture rule, or autofill heuristic.
A neutral custom field is not interpreted as payment authentication data.

## 8. Test first-run password-manager guidance

Use a disposable browser profile or clear Palladin's extension storage.

1. Open Palladin and confirm the guidance appears before Sign in/Unlock.
2. Confirm it explains that Palladin works best as the only active password
   manager and does not claim that any manager was detected.
3. Verify **Open password settings** and **Manage extensions** open
   browser-owned pages or the official public help fallback.
4. Choose **Continue to Palladin**, close and reopen the popup and side panel,
   and confirm the guidance does not repeat.
5. Inspect the manifest and extension details. No target may declare or request
   `management`, enumerate installed extensions, or store extension names/IDs.

## 9. Pair and test Agent Inject on macOS Chrome

This path is development-only and requires the matching `palladin-agent`
repository. From that repository, build the source CLI:

```bash
cd runtime
cargo build -p palladin-cli --features local-development
./target/debug/palladin doctor
./target/debug/palladin browser install
```

`browser install` writes the exact Google Chrome Native Messaging manifest and
prints the shortened host fingerprint. It does not print or accept any secret.

1. In the Palladin popup open **Agent runtime**.
2. Wait for the extension to discover the local runtime automatically.
3. Compare the prefix and suffix of the fingerprint shown by the CLI and popup.
4. Choose **Trust and pair**. No bundle copy/paste is required.
5. Verify the CLI state:

   ```bash
   ./target/debug/palladin browser status
   ```

6. Have the browser framework open and fully prepare the controlled HTTPS login
   page. Preserve its WebExtensions tab ID and exact URL snapshot. Dismiss public
   cookie overlays and complete any human CAPTCHA before Inject.
7. Use an active disposable Agent profile with an approved `Inject` grant, then
   run a value-free form plan such as:

   ```bash
   FORM_JSON='{"version":1,"steps":[{"fields":[{"entryFieldId":"credential.username","selector":"input[autocomplete=\"username\"]","control":"username"},{"entryFieldId":"credential.password","selector":"input[autocomplete=\"current-password\"]","control":"password"}],"submit":{"action":"click","selector":"button[type=\"submit\"]"}}]}'

   ./target/debug/palladin inject <vault-id> <entry-id> \
     --provider extension \
     --target-tab-id <framework-tab-id> \
     --page-url 'https://controlled.example/login' \
     --form-json "$FORM_JSON" \
     --reason "Local extension smoke test"
   ```

8. Approve the Inject request through Palladin if the grant is pending.
9. Confirm Chrome receives the values and the CLI returns only a value-free
   outcome. The credential must not appear in terminal output, logs, the form
   JSON, or the Agent/model context.

The source CLI must already be initialized and connected to the same compatible
API. For a local backend, use the explicitly compiled development build and a
literal loopback host such as `http://127.0.0.1:5000`; never pass an API key in
argv or an environment variable.

Negative checks:

- an unknown-field/stale-challenge discovery offer or mismatched fingerprint is rejected;
- no pairing means no `session.open` and Inject is unavailable;
- a missing tab, stale URL snapshot, changed document, origin, or hostname after
  preparation rejects the operation; changing which tab is active does not move
  the operation away from the exact framework-provided tab ID;
- the extension-owned closed-Shadow-DOM inline launcher does not make its bound
  login form stale, while a foreign element covering a declared control still
  rejects the operation before a secret-bearing write;
- `--provider playwright`, `--provider agent-browser`, CDP, and plaintext pipe
  routes fail closed;
- after unpair reports success, an in-flight or later Inject cannot deliver a
  value.

## 10. Cleanup

Remove the native pairing before deleting the unpacked extension:

```bash
./target/debug/palladin browser unpair --confirm
./target/debug/palladin browser status
```

The final status command is expected to report that the host is not installed
or not paired and to return a non-zero status. Then remove the unpacked extension
from Chrome and delete the disposable Palladin entries/account through the
normal application flow.

## 11. Automated regression gate

Before reporting the manual result, run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit
git diff --check
cmp -s AGENTS.md CLAUDE.md
```

`npm run build` must produce and validate Chromium, Firefox, and Safari
artifacts. Passing these commands does not replace the installed-Chrome manual
test or browser-store certification.
