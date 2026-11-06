# Federated sign-in methods

Status: implemented with synthetic Chromium acceptance; real-provider acceptance
remains open. Capture now has an explicit Firefox 140–152 compatibility boundary
using browser-authenticated live content Ports and worker-issued route identities
when `sender.documentId` is absent. Disconnect/navigation revokes those bindings.
Actual Firefox 140/155 login-capture evidence does not establish federated-provider
acceptance. Further Safari acceptance work was cancelled by the user; native Safari
16.4 remains unverified.

This feature remembers how the user signs in to an **external** service with a
federated provider ("Continue with Google", Apple, Microsoft, GitHub or
Facebook) and which provider account they use, so the next sign-in can offer
the right method and account. It does not change how anyone signs in to
Palladin itself.

## Data model

Each method is a stable-ID canonical custom field inside the encrypted Credential
MemberSecret, so it syncs with the Entry through the existing zero-knowledge
path:

```json
{ "id": "custom:<uuid v4>", "label": "Sign-in method", "type": "palladin.signin.v2",
  "value": { "provider": "google", "account": "alice@example.com",
             "entry": { "vaultId": "<uuid>", "entryId": "<uuid>" } } }
```

- `provider` is a closed set; `account` is the provider account identifier the
  user confirmed (NFC, trimmed, 1..256) or `null` when only the provider is known.
- `entry` references the provider Credential (for example the Google account
  entry) and is set only when the user picks a **discoverable** Palladin
  Credential of that provider; a typed or unknown account has `entry: null`.
  A popup edit keeps the reference only for an unchanged provider and account.
- Agent access is `never` or `discovery` (SDK target `@palladin/crypto` 0.17.0).
  Each method has its own policy. Capture defaults a new method to the Entry's
  discoverability; the popup editor lets the member choose visibility. Editing
  retains the method ID and policy unless visibility is explicitly changed.
  `onGrant*` is rejected; methods never enter grants or the MemberIndex.
- When any v2 field exists, the shared SDK emits only `signInMethods`, containing
  `schema: palladin.signin.v2` and a sorted collection of method ID, provider and
  optional provider Entry reference. Visible recognized v1 methods participate;
  the legacy singleton projection is suppressed even by a hidden v2 field.
  Account identifiers and labels never enter Discovery. The Agent must ask when
  ambiguous; references do not replace existing approval/grant/origin gates.
- New methods use v2. An intentional edit upgrades only that recognized v1 field
  to v2, retaining its exact ID (including hexadecimal case). Untouched legacy
  fields, other policies and opaque/future fields remain byte-for-byte unchanged.
  Removal targets one exact recognized ID. Provider/account is never identity:
  multiple accounts at one provider and repeated provider values remain separate.
- One Credential represents one account at one service host. Several service
  accounts are several Credentials; several provider accounts are different
  `account` values. Nothing is merged by provider or domain.
- A new record created only to remember a method has an empty username and
  password. Automatic exact-host autofill skips candidates with an empty
  username (`inline-autofill.ts`), so it never selects such a record; it stays
  available as an explicit manual choice.
- Unknown versions and malformed values remain opaque, are never offered for
  suggestions or editing, and survive ordinary edits and capture writes.
- Canonical Entry sharing reports this type as unsupported, so a full share is
  blocked and partial shares exclude it: the provider account is personal.

Helpers: `src/shared/signin/binding.ts` (parse/write) and
`src/shared/signin/providers.ts` (provider endpoints).

## What the browser can observe

- A trusted click on a page control whose accessible name or link identifies a
  provider. This is only a hint that a sign-in started.
- The browser-authored top-frame URL of every document registered by the
  content Port (`port.sender.url`) and `tab.openerTabId` for popups. Provider
  identity comes only from exact HTTPS authorization endpoints
  (`accounts.google.com/o/oauth2/...` and the GIS popup `accounts.google.com/gsi/select`,
  `appleid.apple.com/auth/authorize`,
  `login.microsoftonline.com/<tenant>/oauth2/.../authorize`,
  `login.live.com/oauth20_authorize.srf`, `github.com/login/oauth/authorize`,
  `www|m|web.facebook.com/<version>/dialog/oauth`). Lookalike hosts, ports,
  userinfo and HTTP never match.
- A popup is linked to its opener only when the provider document is the first
  registered document of that tab. A link-opened tab that visited another site
  first, or a popup that browses to an unrelated site, never attributes a flow to
  the opener.
- Only a third-party authorization request (`client_id` present, including
  Google's `/v3/signin` and `/signin/oauth` redirects and GitHub's `return_to`)
  can establish or switch the provider of a flow. A generic provider sign-in page
  (for example `ServiceLogin` or `AccountChooser` without `client_id`) can only
  continue a flow whose provider is already established, even after a click
  intent or a suggestion choice.
- The username of a provider Credential that Palladin itself filled on the
  provider page during the flow (taken from the unlocked MemberIndex).

What it cannot and does not observe: which account the provider actually
authenticated, whether the service accepted the result, browser-native
FedCM/One Tap prompts, provider iframes, other browsers, and native apps.
Palladin never reads provider page text to identify an account.

## Flow

1. Service tab S (HTTPS top frame) starts a flow on a recognized trusted click,
   on an explicit suggestion choice, or when a third-party authorization request
   loads in S or in a popup opened by S.
2. A provider document in the same tab or in that popup links the flow and fixes
   the provider from its URL.
3. Return: a later document in S on the same registrable domain, a popup
   redirected back to it, or the popup closing. An OAuth `error` parameter on the
   return (query or fragment) cancels silently.
4. The worker sends a value-free refresh to S. Review expands the closed-shadow
   notification into a capture-only extension-origin iframe to remember the
   sign-in method. The user must explicitly choose the provider
   account (Palladin-filled, already remembered, saved provider Credentials or
   "Account not specified") and where to remember it (an existing exact-host
   Credential, or a new record only when there is no eligible existing match). A single
   exact-host target is preselected; ambiguous targets require a choice. Provider
   accounts are not preselected unless they come from the
   user's own earlier choice or an explicit (manual) Palladin fill of a
   Credential on that provider's account domain in this flow. An automatic fill
   is offered but never preselected, because the user may switch accounts in the
   provider's chooser; a fill that differs from the chosen account counts as an
   account switch and still asks. Actions are ignored for 500 ms after the
   surface appears, so a page-triggered prompt cannot capture a pending click.
   Each account choice is one (account, provider Credential) pair: Credentials with
   the same account stay separate and show their Entry name and Vault, and an
   account-only choice is never silently upgraded to an Entry reference.
   A return to another host of the same registrable domain shows the prompt;
   the write stays bound to the start host.
5. "Remember" performs one canonical encrypted Entry update/create with fresh
   state, base revision, grant re-wrap and repeated document/session checks.
   "Dismiss" mutes the host until Palladin locks. Unlock remains native. Clicking
   the Entry thumbnail explicitly opens the pending draft in the native popup
   before saving or the saved Entry detail afterward.

Flows live only in service-worker memory, expire after ten minutes, are keyed by
tab, are limited to twenty and are discarded on lock. Incognito tabs are not
tracked. Nothing is persisted outside the encrypted Vault: no OAuth code, state,
nonce, token, cookie, callback URL, provider password or account plaintext.
OAuth requests and redirects are never modified; `login_hint` is not injected.

Suggestions read only the local encrypted cache (`revealCurrentEntry`), so an
ordinary page load never sends Entry requests to the server; inconsistent cached
Entries are skipped. The prompt after a return reads fresh server state because
it needs the current revision for the write.

## Next sign-in

When the unlocked worker finds remembered bindings for the exact host and the
page shows a recognized provider control, a closed-shadow card lists every
remembered account. It never acts by itself. Choosing one clicks the page's
unique matching control inside the trusted action (preserving popup user
activation) or, when the control is absent or ambiguous, tells the user which
button to use. For that flow, the chosen provider account is ranked first among
exact-host Credentials on the provider's own sign-in page. That ranking uses the
existing fill-only, no-overwrite, no-submit automatic path described in
[AUTOFILL-POLICY.md](AUTOFILL-POLICY.md); it never selects a different host,
never submits and never bypasses MFA.

## Editing

The popup Entry detail and Login creation form show a final "Sign-in methods"
section after notes, before the footer. The empty section has its heading and plus;
compact rows show provider logo/name, account and a pencil. Visibility is in the
native modal editor, with logo/name provider tiles, an optional manual account,
a visibility switch and the standard Cancel/Save footer. The popup command does
not offer new provider Entry linking; unchanged links are retained by the worker.
Add, edit and remove are explicit actions; edits/removals name the exact
stable field ID in the independently validated `workspace/sign-in` command.

Login creation supports multiple methods and empty username/password when at least
one valid method exists. Changing the create type clears the method draft; non-Login
save commands reject method input. New typed methods have no provider Entry
reference. Editing an existing method retains its approved reference only while
provider/account remain unchanged. Capture still offers the explicit saved provider
Credential choice and appends to the selected service Entry without replacing its
other methods. No account is linked automatically. Lists have no OAuth marks.

The web panel and mobile app edit the same encrypted fields.

## Security properties

- Page messages cannot name an account, Entry, Vault or provider for a write; the
  prompt and suggestions carry only worker-issued opaque IDs bound to the tab,
  browser document and isolated-world document.
- The page notice is a closed shadow surface with safe identity metadata and no
  editable inputs, passwords or OAuth tokens;
  opening review requires a trusted, unobstructed click
  (`createClosedSurface().acceptsAction`). Account and target autocomplete controls
  live in the capture-only extension frame (or the explicitly opened native
  editor). Replacing another remembered provider/account requires an explicit
  replacement checkbox and is rechecked by the worker boundary. Site images use
  the trusted public-asset pipeline; known provider logos are packaged assets.
- Private capability handoff and browser-authenticated Ports bind embedded
  review to the source/candidate/session. Top-layer containment, ancestry/style
  checks and interference rejection mitigate overlays; they do not guarantee
  visibility at the exact click. This is the explicit capture-only residual-risk
  exception in `AGENTS.md`; general Vault, unlock, approval and reveal APIs stay
  outside the embedded surface.
- Confirmation rechecks sender frame, HTTPS origin equal to the flow's service
  origin, document identity and session generation before and during the write.
- No new manifest permission is used.

## Acceptance

Automated:

- Unit: `src/shared/signin/binding.test.ts`, `src/background/signin/coordinator.test.ts`,
  `src/content/isolated/federated-signin.test.ts`,
  `src/popup/workspace/SignInMethodField.test.tsx`, writer and inline-runtime tests.
- Chromium: `npm run test:browser:signin` drives real clicks with routed synthetic
  provider documents: denied return, same-tab Google with explicit multi-account
  choice and encrypted create through explicitly opened native review (historical
  page-Review routing is no longer the contract; Review itself never saves), suggestion choice with chosen-account ranking and
  no re-prompt, GitHub popup updating an existing account, and a storage scan for
  OAuth values and plaintext provider accounts.
- The current Chromium inline matrix separately verifies same-notification
  federated review and explicit save. TOTP and generator use separate harnesses;
  their passing results are not real-provider OAuth evidence.

Manual (not yet performed): real Google, Apple, Microsoft and GitHub accounts
on Chrome, Firefox and Safari, including popup-blocker behavior, FedCM/One Tap
fallback and SPA return without navigation. Safari `openerTabId` and native
Safari acceptance remain unverified; further Safari work was cancelled, not
completed or made a blocker for this task.

## SDK and verification

The extension pins published registry `@palladin/crypto` 0.17.0 with its registry
integrity in the lockfile. Clean `npm ci`, native build/tests and the disposable
Chromium sign-in flow validate the published package, including opening saved
MemberSecret and redacted AgentDiscovery after appending same-provider accounts.
Synthetic verification does not establish real-provider or store acceptance.
Provider logo SVGs are bundled copies of the first-party web panel assets; no remote
assets or new runtime permissions are used.

## Provider editor presentation

The native popup method editor offers a horizontally scrollable provider-logo rail with previous/next controls. Scrolling never selects a provider; keyboard activation and touch select explicitly. Saved-method rows and native modal focus restoration remain unchanged. The generic localized provider-suggestion mail link contains only a subject and the central `VITE_CONTACT_EMAIL` destination. Generic builds leave this unset; Chrome store bundles require the repository `CONTACT_EMAIL` variable through the packaging workflow. No Entry/account values enter the URI or telemetry.
