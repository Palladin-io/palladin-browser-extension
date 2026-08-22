# Architecture

This document describes the implemented development architecture. It is not a
claim that the extension has passed its production release gates.

## Trust boundaries

```text
untrusted page main world
          |
          | narrow, validated window messages
          v
isolated-world content script
          |
          | typed extension messages
          v
background service worker  <---->  extension popup
          |                              |
          | Native Messaging             | HTTPS API
          v                              v
Palladin local runtime              Palladin services
```

The popup owns only non-secret presentation preferences. `language` defaults to
the browser UI language and `theme` defaults to `prefers-color-scheme`; explicit
EN/PL and Light/Dark overrides are persisted in `chrome.storage.local`. Runtime
copy comes from exact-parity locale catalogs, while manifest/store-facing copy
uses MV3 `_locales`. Theme tokens mirror the web panel and never alter the
worker's session, key, or authorization state.

- The page main world is controlled by the visited site. It is never a trust
  anchor, even if a message contains a nonce that page scripts can observe.
- The isolated-world script validates shape, direction, frame, origin, and
  session context. It should receive a plaintext value only for an approved,
  immediate fill.
- The background service worker owns session and authorization gates. A page
  message alone can never authorize secret access.
- Security-relevant confirmation belongs to extension-owned UI. A visited page
  must not be able to read, restyle, or overlay it.
- Login-field suggestions are rendered beside the username/email control by the isolated content script inside a
  closed Shadow DOM. Page CSS/DOM cannot traverse or restyle its internal
  controls; a hostile page can remove or cover the host, which only makes the
  affordance unavailable. Before selection it contains the entry label,
  username display value, normalized domain, and Vault name, but never the
  password, TOTP seed, notes, or arbitrary fields. Exact-host entries are listed
  first. Sibling hosts under the same registrable domain may be presented as
  related-site candidates, but they are never auto-selected and require a
  closed-surface click on that specific Entry for that one operation. The
  username is decrypted only while unlocked and only after the worker has
  established a browser-authored top-frame sender; its temporary MemberSecret object is scrubbed immediately
  after the display value is copied. While Palladin is unlocked, detection of a
  standard empty login form intentionally performs one fill-only operation for
  the first exact-host match without requiring focus, a click, or browser user
  activation. A successful exact-host selection becomes preferred for that
  exact host until the session locks; otherwise the deterministic name-sorted
  first match wins. This preference exists only in service-worker memory and is
  never persisted as a cleartext browsing/Entry history. Existing field values
  are never overwritten, related hosts never enter the automatic path, and
  passive autofill never submits the form. This deliberate product boundary is
  specified in [`AUTOFILL-POLICY.md`](AUTOFILL-POLICY.md).
  Selecting an item sends a
  typed request back to the worker; the worker revalidates the browser-authored
  top-frame sender, HTTPS origin, registrable-domain relationship, tab and
  document before it decrypts and dispatches one immediate fill. A related-site
  operation is rebound to the exact live host for the isolated-world pre-write
  check. The page cannot request an entry by itself or
  cause automatic form submission.
- The same extension has two separate callers: user autofill and Agent Inject.
  User autofill never authorizes Agent access. Agent Inject requires a pinned
  host signing key plus a signed ephemeral session and AEAD-protected frames;
  Native Messaging host allowlisting alone is not treated as authentication.
- Durable pairing state contains only the host public signing key, its derived
  fingerprint, and an opaque non-secret mutation-intent token in extension
  local storage. An active pin is accepted only when its token matches the
  latest successfully written durable intent, so later active-record writes
  restart fail-closed after that intent commits. If the intent write fails, the
  worker attempts to remove the active record, which restarts unpaired when
  successful. If both storage operations fail, the current worker stays
  suppressed and the UI instructs the user to retry before restarting, because
  durable revocation cannot be claimed.
- A synchronous runtime mutation barrier blocks reconnect and new Inject
  admission, then drains fills admitted before the barrier. A DOM message that
  was already dispatched may finish before this linearization point, but Pair or
  Clear cannot commit the active record or return success until it finishes and
  its values are wiped. Therefore no old fill can write after mutation success.
  No Native Messaging host private key or channel session secret is persisted.
  The popup
  accepts the strict `palladin.inject-pairing.v1` JSON bundle printed by the
  trusted runtime CLI, recomputes the fingerprint, and writes the pin only after
  explicit user confirmation. There is no TOFU path and Native Messaging cannot
  create or replace the pin.
- Playwright and AgentBrowser use their own provider adapters and do not connect
  to this extension.

## Secret lifecycle

1. Establish an authenticated Palladin session without persisting plaintext
   bearer credentials. Durable account continuity uses one authenticated
   `palladin.session.sealed.v1` envelope in `storage.local`: XChaCha20-Poly1305
   protects the tokens, an HKDF-SHA-256 subkey is derived from the master key,
   and canonical AAD binds the exact API URL, account, extension runtime,
   Identity KDF context, wrapped private key, and lifetime. Refresh rotation is
   two-phase (`refresh-pending` before the request, then an atomic durable active
   replacement before publishing the new tokens in memory), so a crash or write
   failure cannot silently retain an uncommitted rotated session.
   Password authentication uses the shared `identity-argon2id-password-v1`
   profile and strict bootstrap/account-state binding. A pending TOTP challenge
   owns only its derived master key in worker memory, is bound to the exact API
   URL and lifecycle generation, and is wiped on cancel, logout, server change,
   failed completion, or a five-minute worker-owned expiry; the popup never
   retains the master password.
2. Keep cryptographic keys only in service-worker JavaScript memory. A worker
   restart loses them and restores a compatible account only as locked; explicit
   lock and logout wipe them immediately. While the
   session is unlocked, isolated content scripts and the persistent side panel
   send a private, value-free liveness ping every 20 seconds. After explicit popup unlock, a fixed
   `activeTab`/`scripting` bootstrap installs that same heartbeat in the current
   top frame if it was already open before an unpacked install/reload. It has no
   DOM or secret payload. This prevents Chrome's routine idle retirement when
   the popup closes or the active tab changes, but never carries key/token/user
   state, never enters the page-facing bridge, and never calls the activity path
   that extends auto-lock. Browser/worker termination remains fail-closed.
3. Persist the sealed authentication envelope in `storage.local`, and canonical
   Vault ciphertext envelopes plus structural sync cursors in IndexedDB. Decrypt
   only at the latest point required for a user-approved operation. Obsolete
   plaintext session records are deleted without migration.
4. Bind preparation to the active tab and browser-issued top-frame document ID,
   then validate the isolated page-load ID, exact HTTPS origin, registered
   domain, and authorization again immediately before filling.
5. Drop plaintext references after use and clear temporary byte buffers where
   the platform permits it.

The extension uses the shared Palladin cryptographic package for canonical Vault
Protocol 2 envelopes and the Inject secure session. Cryptography is not
reimplemented in popup, content-script, or service-worker handlers. Extension
pages allow the narrow Manifest V3 CSP source `wasm-unsafe-eval` solely because
that reviewed package instantiates its bundled WebAssembly module; generic
`unsafe-eval`, remote scripts, and remote WebAssembly remain prohibited.
Entry icons may load only from the immutable Palladin public-asset origin (or
the fixed localhost asset origin in development), with no referrer; arbitrary
remote image origins remain blocked by both URL validation and the extension
page `img-src` CSP.

## Messaging contract

Messages should form a discriminated union with runtime validation at each
boundary. Protocol changes require tests for valid messages and for rejection
of wrong source, direction, frame, origin, nonce, type, payload, and session.

Messages must carry the minimum data needed for one operation. Broad state
snapshots and generic `unknown` payload relays make review harder and are not an
acceptable extension point.

Inline user autofill uses a separate `palladin.inline-autofill.v1` message
family. A list response is password-free and contains exact-host entries plus
explicitly labelled related-host Credential presentation fields, including the
username needed to distinguish multiple accounts. A fill request carries the
selected Vault/Entry IDs, exact/related scope and the
isolated-script page-load document ID. The service worker additionally requires
the browser-provided sender document ID and reconstructs the exact active target
instead of trusting any tab, origin, or URL supplied by page content.
When the session is locked or signed out, the closed-shadow menu can open the
browser-owned Palladin side panel directly from the user's click. This command
carries only the document binding and never a credential value.

Chrome closes long-lived extension ports when a page enters the back/forward
cache. The isolated content script consumes that expected disconnect and opens
a new typed port when the preserved document is restored. The normal
top-frame/document/origin checks still apply to every fill after reconnection.
The same typed Port receives only a coarse worker-owned liveness control. Pings
exist exclusively while the worker reports `unlocked` and receive no response,
so a visited page cannot infer unlock state from bridge traffic.

Agent Inject uses `palladin.inject-provider.v1`. The local runtime decrypts an
approved Inject grant and transfers one credential over private pipes to the
Native Messaging host. A paired session begins with `session.open` /
`session.ready`; the signed transcript binds the extension origin, both nonces,
and both ephemeral keys. All prepare/inject traffic then travels only in
sequence-checked AEAD `secure` frames. The extension validates replay state,
active tab/document, HTTPS origin, and the authenticated runtime-provided target
domain before fill and before submit. It returns only a value-free outcome. The
declarative payload remains `form+values`; there is no CDP transport. Removing
the pin immediately disconnects and disposes the channel. Production host
packaging and installed-browser validation remain release gates, so this path is
not enabled in release builds today.

Manual Add entry uses one canonical write command for Credential, Key, Script,
and Credit card. Every extension-created field defaults to `never` for Agent
disclosure; granting access remains an explicit management action. Custom-field
order is part of the canonical plaintext and the up/down UI moves existing
objects without regenerating their IDs. A Credential has one primary `Log in`
orchestration: fill and submit the current exact HTTPS form first, fall back to
opening the stored host only on `no-form`, then fill and submit its bound form,
and never turn a target/security failure into navigation. Submit is an explicit
boolean on the strict worker-to-isolated fill message; only `Log in` sets it,
while ordinary fills, generator fills, card fills, and automatic fills set it to
false. Heavy entry management uses an exact Vault/Entry deep link in a
separate action row that can later accept actions such as Share. User card
fill is a separate explicit popup action. It maps canonical card data
only to standardized `cc-name`, `cc-number`, expiry, and explicitly billing
address autocomplete fields. It does not infer payment fields from labels or
generic custom fields.

Copy is exposed only on Chromium, where an offscreen document performs the
reviewed TTL clipboard wipe. Firefox and Safari hide the control, and their
workers reject copy reveal/arm commands before requesting plaintext.

## Browser permissions

The manifest is security-sensitive source code. Every permission and host must
have a documented consumer and threat analysis. Prefer temporary `activeTab`
access and narrow hosts over persistent access. A proposed `<all_urls>` content
script requires explicit security review and is not an assumed default.

`scripting` is used only after the user explicitly opens the popup and unlocks:
it installs the fixed value-free liveness bootstrap in the active top frame so
an already-open page can keep the in-memory worker session alive. It never
injects a secret or arbitrary source.

The production, staging, and default localhost API origins are install-time host
permissions. An HTTPS self-hosted origin or `127.0.0.1` is requested only after
the user submits its exact URL in extension-owned Settings; the service worker
checks that permission again before committing the change. HTTP is rejected for
every non-loopback host. The persisted setting contains only the normalized,
non-secret API base URL. A changed URL first terminates the current session,
removes the sealed account envelope, wipes in-memory keys, and clears the
ciphertext cache. Session tokens carry the
exact issuing API URL and are rejected and cleared if they do not match the
current server, so a token can never cross a server boundary.

The service worker owns a generation/lease barrier for this transition. Login,
TOTP, refresh, popup Vault commands, capture writes, unlock refresh, and periodic
sync hold a lease across the complete operation. A server mutation closes new
admission, drains the old generation, invalidates any background-owned TOTP
challenge, logs out, clears every IndexedDB ciphertext-cache partition, commits
the new URL, and only then reopens admission. Server-origin optional permission
cleanup runs inside the same serialized transition; popup contexts never remove
host permissions from stale pre-change state.

Password-manager coexistence is guidance, not discovery. No target declares
`management`, reads the installed-extension list, or infers that a built-in or
third-party manager is enabled. A first-run screen explains the concrete
symptom - duplicate icons and suggestion prompts - and offers browser-owned
password and extension settings through explicit user gestures. Palladin never
disables or uninstalls another product.

The screen is gated by the versioned, non-secret local marker
`palladin.onboarding.password-manager-guidance.v1`. Only the literal completed
state suppresses it; malformed state is treated as not completed. After the
user continues, the guidance does not recur unless extension data is cleared or
a future onboarding version deliberately uses a new key. No installed software
metadata is stored, logged, analysed, or sent to Palladin.

## Build and release boundary

A resumed implementation should produce auditable, reproducible Chromium
artifacts first. Firefox or Safari support should use small reviewed manifest
overlays rather than forks of the security-critical core.

The interaction model is hybrid: inline suggestions are the primary login
affordance, the action popup remains the compact quick-action surface, and a
persistent side panel/sidebar hosts the complete Vault browser. Chromium uses
`side_panel` plus an immediate user-gesture `sidePanel.open`; Firefox uses
`sidebar_action` plus `browser.sidebarAction.open`. Both are small target
adapters over the same React App, worker commands, EN/PL catalogs and theme
tokens. Safari has no equivalent in the current foundation and honestly retains
the popup. Autofill does not depend on any of these surfaces.

The side panel is full height: header, navigation and footer remain stable while
the Vault list or form owns the single scroll region. A value-free lifecycle
event refreshes session/Vault presentation after lock, unlock, logout and
mutations. Active-tab navigation refreshes exact-host matches from the local
encrypted cache without remounting the surface, losing its search/expanded-row
state, or starting a REST synchronization. Background-tab completion is ignored.
No keys or plaintext move into the UI shell.

Vault refreshes are coalesced and freshness-gated. SignalR
`ReceiveVaultSyncInvalidation` is the primary live path while the worker is
unlocked: its strict value-free payload identifies one Vault and monotonic
structural version, and the worker fetches only that Vault's authenticated
detail/delta. Duplicate and out-of-order hints are coalesced; a removal
tombstone wins over an update at the same mutation version. Unlock and SignalR
reconnect perform a full all-Vault repair. Popup/side-panel mounts, active-tab
changes and page reloads rebuild presentation from encrypted local cache
without forcing backend requests. The existing 15-minute alarm runs only while
unlocked as a repair mechanism for missed events after MV3 suspension or
transport loss; it is not the primary synchronization channel. Local writes
still reconcile immediately.

The web panel and browser extension deliberately keep separate client sessions,
memory-only keys and ciphertext-cache stores. Their common source of truth is
the backend's encrypted Vault state, coordinated by value-free SignalR
invalidations and authenticated REST repair. Neither client transfers an MK,
private key, bearer/refresh token or unlock capability to the other, so unlocking
one surface never implicitly unlocks the other.

An expired freshness window does not imply a full Vault download. The first
request is the encrypted Vault list, used as a change manifest. For a cached
Vault, the worker requires an exact match of its structural projection, applied
Member sequence, organization scope and authoritative metadata revision. An
unchanged Vault then needs no detail, delta or snapshot request. A changed or
new Vault gets its strict detail projection and Member delta; `resetRequired`
still replaces that one Vault from the paged snapshot before catching up with
deltas. This preserves the Protocol 2 validation boundary while reducing the
steady-state refresh from list + detail/delta per Vault to one list request.

The Vault list groups repeated entries by normalized website host. Its collapsed
summary shows only the login count; Vault identity belongs to each expanded
account row. Opening a group is the explicit action that decrypts only those Credential usernames for
transient display; the metadata cache remains username-free. This avoids a bulk
decrypt on initial render and keeps accounts distinguishable by username and
Vault.

The inline account row has two explicit targets. Selecting the account fills
the bound login form without submitting it. The separate enter-arrow action
fills and calls `requestSubmit()` on the exact form that owns the username
launcher field. Scripted page focus cannot invoke either secret-bearing action.
The overlay sets its own important-priority system font stack and does not
inherit typography from the visited site. Its surface reuses the web panel's
light/dark notification gradients.

Manual Add entry supports neutral `text`, `multiline`, and `concealed` custom
fields. IDs are stable `custom:<uuid>` values inside canonical MemberSecret;
all extension-created custom-field access is `never` until a later explicit
management action changes policy. No label is interpreted as CVV, PIN, or an
autofill heuristic.

Release work must add, at minimum, locked dependencies, type checking, unit and
integration tests, permission-diff review, artifact hashes, an SBOM, provenance
attestation, and a documented browser-store signing process.
