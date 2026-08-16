# Local testing

This runbook verifies the development extension without treating it as a
production release. Use a disposable Palladin account, dummy credentials, a
test card number, and a login page that you control. Never use a real password,
payment card, CVV/CVC, or PIN.

## What can be tested

| Flow | Local status |
|---|---|
| Sign-in, unlock, lock, and sign-out | Chromium development build |
| User-selected credential autofill | Chromium development build on a controlled HTTPS page |
| Generated-password Fill then explicit Save | Chromium development build on a controlled HTTPS page |
| Card save and user-selected autofill | Chromium development build with dummy card data |
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

If the selected/default Vault has an active `FULL` grant, new credential and
card saves currently return `grant-refresh-required`. Updating an existing
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
5. Unlock, then click **Sign out**. Confirm the popup returns to **Sign in**.

Reloading or restarting the service worker must fail closed to a locked state;
keys are not restored from browser storage.

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
2. Open Palladin, expand the matching Credential, and click **Fill**.
3. Confirm only the expected username and password controls receive the dummy
   values.
4. Navigate the same tab to a different hostname and retry. The fill must be
   rejected.
5. Test a subdomain only if the entry explicitly opts into subdomain matching;
   the default is exact-host matching.

The extension must not choose a Credential or submit a form merely because page
content asks it to.

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

## 7. Test card save and autofill

Use dummy values only. A suitable non-production test number is Visa's common
test value `4111111111111111`; it is not a real payment card.

1. In the popup choose **Add card**.
2. Save a dummy label, cardholder, card number, future expiry, and optional
   billing address.
3. Open a controlled HTTPS checkout form containing `cc-name`, `cc-number`,
   `cc-exp-month`, `cc-exp-year`, and a separate `cc-csc` input.
4. Expand the card entry and click **Fill**.
5. Confirm cardholder, PAN, expiry, and supported billing controls are filled.
6. Confirm the `cc-csc`/CVV/CVC and PIN controls remain empty.

There is no dedicated CVV/CVC or PIN field, capture rule, or autofill heuristic.
A neutral custom field is not interpreted as payment authentication data.

## 8. Pair and test Agent Inject on macOS Chrome

This path is development-only and requires the matching `palladin-agent`
repository. From that repository, build the source CLI:

```bash
cd runtime
cargo build -p palladin-cli --features local-development
./target/debug/palladin doctor
./target/debug/palladin browser install
```

`browser install` writes the exact Google Chrome Native Messaging manifest and
prints one JSON pairing bundle to standard output. It prints a shortened
fingerprint separately. The JSON contains only a public signing key and its
fingerprint; it contains no secret.

1. In the Palladin popup open **Agent runtime**.
2. Paste the one-line JSON pairing bundle.
3. Compare the prefix and suffix of the fingerprint shown by the CLI and popup.
4. Check the explicit confirmation box and choose **Pair runtime**.
5. Verify the CLI state:

   ```bash
   ./target/debug/palladin browser status
   ```

6. Keep the controlled HTTPS login page active and fully prepared. Dismiss
   public cookie overlays and complete any human CAPTCHA before Inject.
7. Use an active disposable Agent profile with an approved `Inject` grant, then
   run a value-free form plan such as:

   ```bash
   FORM_JSON='{"version":1,"steps":[{"fields":[{"entryFieldId":"credential.username","selector":"input[autocomplete=\"username\"]","control":"username"},{"entryFieldId":"credential.password","selector":"input[autocomplete=\"current-password\"]","control":"password"}],"submit":{"action":"click","selector":"button[type=\"submit\"]"}}]}'

   ./target/debug/palladin inject <vault-id> <entry-id> \
     --provider extension \
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

- a malformed bundle or mismatched fingerprint is rejected;
- no pairing means no `session.open` and Inject is unavailable;
- changing the active tab, document, origin, or hostname after preparation
  rejects the operation;
- `--provider playwright`, `--provider agent-browser`, CDP, and plaintext pipe
  routes fail closed;
- after unpair reports success, an in-flight or later Inject cannot deliver a
  value.

## 9. Cleanup

Remove the native pairing before deleting the unpacked extension:

```bash
./target/debug/palladin browser unpair --confirm
./target/debug/palladin browser status
```

The final status command is expected to report that the host is not installed
or not paired and to return a non-zero status. Then remove the unpacked extension
from Chrome and delete the disposable Palladin entries/account through the
normal application flow.

## 10. Automated regression gate

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
