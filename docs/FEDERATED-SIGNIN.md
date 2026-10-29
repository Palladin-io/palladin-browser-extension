# Federated sign-in methods

Status: implemented on a feature branch for the Chromium family; synthetic
Chromium acceptance passes; real-provider acceptance is open. **Firefox and
Safari are currently unsupported:** the sender gate requires the browser-issued
`sender.documentId`, which those targets do not provide, so every command is
rejected as stale and nothing is observed or written there (see "Acceptance").

This feature remembers how the user signs in to an **external** service with a
federated provider ("Continue with Google", Apple, Microsoft, GitHub or
Facebook) and which provider account they use, so the next sign-in can offer
the right method and account. It does not change how anyone signs in to
Palladin itself.

## Data model

The binding is one canonical custom field inside the encrypted Credential
MemberSecret, so it syncs with the Entry through the existing zero-knowledge
path:

```json
{ "id": "custom:<uuid v4>", "label": "Sign-in method", "type": "palladin.signin.v1",
  "value": { "provider": "google", "account": "alice@example.com",
             "entry": { "vaultId": "<uuid>", "entryId": "<uuid>" } } }
```

- `provider` is a closed set; `account` is the provider account identifier the
  user confirmed (NFC, trimmed, 1..256) or `null` when only the provider is known.
- `entry` references the provider Credential (for example the Google account
  entry) and is set only when the user picks a **discoverable** Palladin
  Credential of that provider; a typed or unknown account has `entry: null`.
  A popup edit keeps the reference only for an unchanged provider and account.
- Agent access is `never` or `discovery` (`@palladin/crypto` >= 0.14.0). A new
  field is discoverable exactly when its Credential is discoverable; replacing a
  recognized field keeps its access. `onGrant*` is always rejected, so the field
  is never delivered in a grant and never part of the MemberIndex.
- With `discovery`, the shared SDK projects only
  `{"id":"signIn","value":"{\"entry\":…,\"provider\":…,\"schema\":\"palladin.signin.v1\"}"}`
  into Agent Discovery — **never the account**. An Agent can then request the
  normal, user-approved grant for the referenced provider Credential and sign in
  through the provider page with Inject. Two discoverable methods expose nothing.
- One Credential represents one account at one service host. Several service
  accounts are several Credentials; several provider accounts are different
  `account` values. Nothing is merged by provider or domain.
- A new record created only to remember a method has an empty username and
  password. Automatic exact-host autofill skips candidates with an empty
  username (`inline-autofill.ts`), so it never selects such a record; it stays
  available as an explicit manual choice.
- Unknown, malformed or duplicated `palladin.signin.v1` values are shown as
  unrecognized, never used for suggestions, and preserved unless the user
  explicitly replaces or removes them.
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
4. The worker sends a value-free refresh to S; the closed-shadow prompt asks
   "Signed in with Google?". The user must explicitly choose the provider
   account (Palladin-filled, already remembered, saved provider Credentials or
   "Account not specified") and where to remember it (an existing exact-host
   Credential or a new record). Nothing is preselected unless it comes from the
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
   "Not now" mutes the host until Palladin locks.

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

The popup Entry detail shows "Sign-in method" for Credentials with explicit
Change, Remember and Forget actions (`workspace/sign-in`). The web panel and the
mobile app edit the same field.

## Security properties

- Page messages cannot name an account, Entry, Vault or provider for a write; the
  prompt and suggestions carry only worker-issued opaque IDs bound to the tab,
  browser document and isolated-world document.
- The prompt is a closed shadow surface without text inputs; actions require a
  trusted, unobstructed click (`createClosedSurface().acceptsAction`).
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
  choice and encrypted create, suggestion choice with chosen-account ranking and no
  re-prompt, GitHub popup updating an existing account, and a storage scan for
  OAuth values and plaintext provider accounts.

Manual (not yet performed): real Google, Apple, Microsoft and GitHub accounts
on Chrome, Firefox and Safari, including popup-blocker behavior, FedCM/One Tap
fallback, SPA return without navigation, and Safari `openerTabId` availability.
