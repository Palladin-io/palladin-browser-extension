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
- Login-field suggestions are rendered beside a username/email control only when
  its owning form also contains a usable password field. A standalone email or
  username form never receives a Palladin launcher. The isolated content script
  renders the launcher inside a
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
  document before it decrypts and dispatches one immediate fill. The request
  carries a value-free isolated-world target identity, and the final handler
  requires the same rendered username, password, and owning form to remain
  eligible before each DOM write. A related-site operation is rebound to the
  exact live host for the isolated-world pre-write check. The page cannot
  request an entry by itself or
  cause automatic form submission.
- The same extension has two separate callers: user autofill and Agent Inject.
  User autofill never authorizes Agent access. For Agent Inject, the Runtime
  authenticates the receiving extension before credential access: Chrome must
  supply the exact compiled extension origin from `allowed_origins`, and the
  native host additionally validates its direct Google-signed Chrome parent.
- The extension does not authenticate through a Palladin account, profile, or
  key. It is only the browser-controlled bridge to the exact tab/document. It
  stores no host key, fingerprint, or pairing intent. Obsolete pairing records
  are deleted on startup without migration.
- The Native Host owns an installation-scoped signing identity only for the
  encrypted host↔extension session and mutually authenticated local CLI↔host
  channel. It announces the public key in a strict, value-free `session.offer`;
  the extension keeps it only for that Native Messaging port and verifies the
  signed ephemeral transcript. This session-local check is not the authority
  that lets the Runtime release a credential—the browser/platform identity
  boundary is.
- The owner-only local socket has one exclusive listener, so at most one host
  process can be the provider for an Inject operation. A missing provider or a
  competing host fails before credential access. Uninstall revokes the lifecycle
  token and linearizes against in-flight forwarding.
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
   failure cannot silently retain an uncommitted rotated session. A transport
   failure or HTTP 429 restores the prior sealed active envelope and keeps the
   unlocked session retryable; an explicit refresh rejection still clears the
   session fail-closed.
   Password authentication uses the shared `identity-argon2id-password-v1`
   profile and strict bootstrap/account-state binding. Unknown emails receive a
   same-shaped deterministic pseudo AccountId and salt, so the worker runs the
   identical KDF and backend login path without a local sentinel. A pending TOTP
   challenge owns only its derived master key in worker memory, is bound to the exact API
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

Agent Inject uses `palladin.inject-provider.v1`. The Native Host first sends a
value-free `session.offer`; the extension keeps that public key only in memory,
then `session.open` / `session.ready` bind the browser extension origin, both
nonces, both ephemeral keys, and the announced signing key. All prepare/inject
traffic then travels only in sequence-checked AEAD `secure` frames. The Runtime
sends `prepare` before opening the Agent profile, grant, or credential. A browser framework supplies the
`targetTabId` and exact `targetUrl` snapshot during secretless preparation. The
extension independently resolves only that WebExtensions tab ID, requires the
observed top-frame URL to match, and pins its document ID. It re-resolves that
same tab and validates replay state, document, HTTPS origin, and the authenticated
runtime-provided target domain before fill and before submit. Every fill message
also carries the expected isolated-world page-load document ID, which the content
script checks before its first DOM write. The routing pair is never authorization.
The isolated-world visibility gate ignores only the exact extension-owned inline
surface objects registered in the current controller. It still rejects any page-owned
or otherwise foreign overlay; a page cannot bypass the gate by copying an element name
or marker. It returns only a value-free outcome. The declarative payload remains
`form+values`; there is no CDP transport. `palladin browser uninstall --confirm`
revokes active host sessions and removes the manifest. Production host
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

Fresh installation also opens the branded full-page onboarding surface. Its
import action uses the value-free web-panel intent `/vaults?intent=import`;
after login, unlock, and authoritative Member sync, the panel resolves the
server-owned default Vault marker and opens that Vault's existing client-side
Import Wizard. The extension never receives or guesses a Vault ID for this
handoff.

Entering the full-page account step completes the replaced popup-guidance
marker before the user presses Open sign-in. That handler then calls the
browser-owned action popup as its first awaited operation, preserving the
transient user activation required by browser popup APIs; storage work never
precedes that call. Chromium versions where ordinary extensions cannot use
`action.openPopup()` fall back to the same extension-owned popup document in a
new tab; the handoff never redirects sign-in through a remote page. Account
creation lives on the signed-out popup surface next
to the actual sign-in form and opens web registration in a new browser tab; it
is not a competing action in the full-page wizard.

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

Vault refreshes are coalesced and freshness-gated. The persistent IndexedDB
cache contains only authenticated Protocol 2 ciphertext envelopes, structural
heads/cursors and the finite Policy 2 access context; it never contains an
opened Vault key, Entry key, MemberSecret, MemberIndex or presentation
plaintext. A complete current-entry head is committed atomically as
`EntryKey + MemberIndex + MemberSecret`, so fill/reveal/copy/TOTP need zero HTTP
requests after unlock, including after an MV3 worker restart. Exact lease
expiry, a wall-clock rollback beyond five minutes, a scope/revision/generation/
key binding mismatch, revocation or decryption failure purges that Vault and
fails closed. An organization policy of `disabled` is the one exception to
durability: a freshly synchronized complete item may exist only in worker
memory while SignalR/REST connectivity is live, and is discarded on transport
loss, lock or worker retirement.

SignalR
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
new Vault gets its strict detail projection and the combined
`current-entries/sync/delta` stream. `resetRequired` first purges the active
generation, stages one bounded combined snapshot page at a time, catches it up
with a closing delta, then swaps the namespace atomically. A tombstone is
terminal within a generation, so a delayed or duplicated old head cannot
resurrect a removed Entry. A replacement snapshot whose base sequence regresses
below the prior or reset high-water mark is rejected before staging. Profile
ciphertext is capped at 512 MiB and the page
plus cursor transaction aborts without publication when the cap is exceeded.
Unlock and reconnect deliberately force the closing delta even for an unchanged
manifest; a routine freshness check can still stop at the list.
When a synchronized head changes after it was filled, the isolated inline
surface compares its local freshness marker and shows “fill again” without
performing a second automatic fill or waiting for the network on the original
fill path. That marker is memory-only and is cleared on lock.

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

## Shared unlock session components (CVT-583, pre-release)

`background/shared-unlock/api.ts` follows the Identity session contract with typed
responses and generated consumer fixtures. Source requests use the source's own
session; consume/commit run as receiver requests with one-shot proofs. No source
token crosses the peer channel. Requests reject environment changes/cancellation
before and after asynchronous boundaries and never retry a consumed operation.

`shared/crypto/shared-unlock-keys.ts` composes only the published crypto package:
verify Identity's key-context commitment against the authorized operation, unwrap
the private key with the recovered MK and derive/compare its public key against
Identity's independent descriptor. It owns temporary buffers and wipes failures.
This cryptographic boundary does not duplicate backend business invariants.

The SessionManager installer is captured before receiver proofs. It refuses an
account switch and fences local lock/logout, a newer manual/automatic attempt,
route changes and expiry during sealing, storage and publication. A failed
installation removes only its own envelope and leaves any newer session alone.
A concurrent lock preserves a prior own sealed session; logout/environment
revocation prevents its restoration;
the receiver transaction revokes the newly committed receiver lineage separately.
Duplicate installation cannot replace or wipe the successful independent session.

The receiver preserves original unlockedAt and idle/absolute/offline deadlines.
Actual own activity may move idle only within original ceilings; policy changes
and on-close do not remove inherited deadlines. Key reads enforce those deadlines
synchronously when browser alarms are late, including a shorter local idle policy. Worker restart retains no keys and
requires a new authorized operation or manual unlock. Turning sharing OFF must
not alter these own-session limits.

The configured browser coordinator now invokes these components after native
route/account/link selection and adopts verified own receiver authority. Shared
closing/expiry/preference coordination and surfaces remain release gates; there
is no claim of end-to-end platform acceptance.


Manual login/password unlock now prepares its own Identity authority before
publishing keys. The password-derived AuthCredential goes only to Identity,
never to a peer or durable storage. TOTP retains it only for the pending manual
challenge; expiry/cancel/lock/logout erases it. The password source exposes a
synchronous borrowed-proof callback, so inherited MK installation cannot derive
or manufacture this proof. Failed/offline/step-up preparation leaves sharing
unavailable and permits the ordinary own password unlock.

`shared-unlock/source-authority.ts` reads current account preference and authorizes
one fresh RAM generation with current credential/wrapper revisions. OFF can
prepare an own root but remains OFF; there is no preference write or automatic
retry. Reset/timeouts wipe pending proof and reject late success. The own Identity
ceilings use the existing durable-session expiry plus the actual local idle policy;
these are not Vault access leases. Signed per-Vault offline authorization remains
independent. New handoffs, inherited roots and own activity still need the browser
coordinator; no shared key route is exposed by this preparatory hook.


`shared-unlock/chromium-browser.ts` now registers a strict external hello/ready
Port when explicit public build configuration is present. `chromium-route.ts`
binds browser-authored top-frame tab/document/origin to the configured API/Web
pair, rechecks the current frame and permanently retires on navigation or teardown.
Server-setting changes suspend admission and retire pending/live routes before
mutation; completion resumes admission without reviving any old route. The channel
nonce is not a crypto/source generation. There is still no key/account/token
message and no call from this channel to source/receiver session coordinators.
See SHARED-UNLOCK-PLATFORM-EVIDENCE.md for permission justification, exact config,
negative tests and the limited actual-product Chromium probe.

The receiver Identity API now accepts an `onIssued` commit observer. An available
successful response body reaches this observer before cancellation/environment
fencing rejects the result. The coordinator must capture the newly issued lineage
there and use `revokeIssuedSession` if installation fails or was cancelled. That
cleanup uses only the captured receiver refresh token and original API URL, without
bearer/cookies/redirects/retry, and has an independent two-second bound even if the
transport ignores abort. It does not mutate the current local session or emit a
peer/group logout. No observer fires for a failed response or unreadable/lost body;
a consumed commit is never replayed to recover a missing token. These API mechanics
still require the actual receiver transaction and browser coordinator to call them.


`shared-unlock/receiver.ts` now composes the published SDK proof/DH receiver,
Identity consume/commit, key recovery and SessionManager installation. The browser
coordinator must supply account/org/link/preference and exact document/generation
bindings independently of the offered operation. Both signed proofs bind the
operation; the consumed Identity descriptor supplies member-key authority; the
committed transcript must match before installing only the receiver's own tokens.

The installer exposes a monotonic completion fact at its final synchronous route/
local-generation check. A disconnect queued before the install promise resumes
cannot revoke an already completed own session. ACK carries only operation ID
and Web/Extension generations; loss never retries the operation or logs out a
completed receiver. An incomplete available late commit body triggers bounded
own-lineage cleanup on the original Identity. Lost bodies are never replayed.

A synchronous installer AbortSignal cancels pending receiver work on local lock,
logout, manual work or a newer receiver. It wipes recovered temporary keys even
when commit transport is stalled. The receiver also applies the route signal and
30-second attempt deadline. Installation owns its buffers through asynchronous
storage rollback; it does not race cancellation against rollback completion.
Real SDK/SessionManager tests cover these boundaries with mocked Identity and a
synthetic Entry primitive. The pre-release coordinator below now invokes the transactions after account/link
selection. These isolated transaction tests are not full browser E2E proofs.


`shared-unlock/source.ts` now creates an extension-to-Web operation using only
its own SessionManager session and current source authority. A worker-only source
capture borrows existing keys/tokens, reads effective limits synchronously and
invalidates on lock/logout, manual work, a newer receiver or token rotation.
Disposal drops references and stops that operation without changing the own
session. It performs no storage write, activity update or implicit token refresh.

The source compares account/org/link/preference and exact browser document/
generations to independent authority, plus its own root/key revisions. Published
SDK crypto validates participant keys/transcript and the descriptor commitment;
recovered private key must equal the independently held own Member private key.
Outgoing projection includes only protocol fields, including nested context and
descriptor. A final asynchronous browser verification and synchronous send remain
inside the own-session/route/30-second fence. Send failure is not retried.

Source tests use real SDK and SessionManager with mocked Identity/root preparation,
including actual token rotation cancelling an already pending operation. They
recover Member/Vault keys and decrypt a synthetic Entry primitive; they do not
wire browser dispatch or establish inherited-source/link/preference authority.


`shared-unlock/link-store.ts` persists one nonsensitive marker per exact API/Web
origin/extension ID/account in worker-owned local storage. It allocates the link
ID before Identity creation and reuses it after failure/restart. Existing different
IDs and malformed persisted records are unavailable, never new first use. Ordinary
session logout does not erase these markers. Backend response projection writes
only known link fields; structural validation applies to persisted bytes, not to
authenticated first-party response business rules.

The marker retains last observed Identity link state plus at most two pending
closing intents: lock or the stronger logout, and an independent disconnect.
Disconnect cannot replace logout. A separate local disconnect ID survives newer
active server observations; only the exact explicit reconnect receipt may clear
it, provided no newer closing decision invalidated the attempt. A receipt clears only its exact intent ID;
older observations cannot regress a previously accepted revision or clear newer
pending actions. Writes are serialized by the one worker. The caller must cancel
local work before awaiting persistence/network. A failed write remains retained
in worker memory and blocks all normal reads/activation until the exact write
is repaired; stronger closing actions can still be retained during that repair.
Only successful persistence proves survival across worker termination. These records contain no keys, token,
password proof, operation envelope, source generation or deadlines.

`shared-unlock/prepare-link.ts` uses an existing own source session/root, verifies
the browser, fetches the current preference and reads or creates the same Identity
link before activation. Pending closing intent, retained revocation and disappearance
of an already known link prevent automatic activation. Each asynchronous boundary
checks the own session/root, current preference, route and 30-second deadline;
final browser verification also rechecks locally accepted link revision/intents.
It uses the authenticated activate endpoint for fresh root binding; it does not
reconstruct backend authorization rules. Preference refresh changes only the
existing own generation's preference and cannot renew its root or deadlines.

The configured browser coordinator invokes the durable store; Web also has an
origin-wide locked marker store. Closing-intent delivery/reconciliation and
explicit reconnect remain to be wired with shared actions/settings. Tests prove
storage/Identity preparation boundaries using mock Identity and real SessionManager,
not automatic unlock or full browser lifecycle acceptance.


## Browser operation transport (implementation increment)

The established Chromium route now supports strict bounded operation frames:
source offer, receiver DH/proof offer, encrypted handoff, ACK and cancellation.
The outer attempt ID is separate from the ACK payload, which still contains only
operation ID and Web/Extension generations. API, handshake nonce, channel ID and
browser document binding must match the live route. Extra fields and oversized
crypto encodings are rejected at this independent browser-input boundary; this
does not add first-party REST response validation or replace SDK crypto binding.

`browser-transfer.ts` composes the existing source/receiver transactions. The
caller must supply independently selected account/org/link/preference/generation
authority to their factories. Each attempt has a 30-second timer plus wall-clock
checks, retires late factory results, and removes subscriptions on completion or
failure. A receiver waits for its real install/rollback to finish; it does not
race storage work against transport cancellation. Lost or incorrect ACK does not
resend the handoff or undo a completed own session. No token is sent to the peer.

Extension verifies the browser's current top-frame document before dispatching
each frame, serializing dispatch with a bounded queue. Web verifies its own
live document. Navigation, peer loss, malformed/mismatched frames or operation
input without a coordinator retire the channel. The extension exposes a
synchronous onReady registration hook. Both configured product bootstraps now
register the pre-release coordinator described below.

Focused tests compose the runner with real source encryption and real receiver
consume/commit/session installation using mock Identity. Negative cases cover
stale attempts, order, substituted browser bindings, expanded payloads, late
factories, wall-clock expiry, lost ACK and waiting for installer rollback. These
are not actual browser Identity/MK handoff or full supported-platform evidence.
The paired native Chromium probe was rerun at 2026-09-11T04:43:10.380Z: all 11
hello/ready/document/bootstrap checks pass on Chromium 153.0.8010.12/macOS arm64
under the actual Web CSP, without accounts or a cryptographic handoff.


## Automatic browser coordinator — pre-release integration

Configured Chromium/Web bootstraps now register the real account/link coordinator
on each browser-confirmed route. Before any crypto offer, clients exchange a
bounded state record containing status, account ID, a fresh state ID, the own
source generation (or a new receiver generation), and source organization. The
receiver must be locked/signed out and either have no account or the same account.
A different signed-in account is never replaced. Two unlocked clients do not
start a reverse handoff just because an earlier handoff completed.

Extension allocates the scoped profile link ID; Web adopts exactly that ID and
acknowledges successful persistence before an Extension source may prepare it.
The source reads fresh Identity preference/link state and activates the selected
link through its own tokens/root. The resulting epoch/preference agreement is
sent before the crypto offer. Receiver expectations combine that explicit
preparation contract with independently selected account/org/generations, the
local link marker and native browser/document identity; they are not extracted
from the operation or encrypted envelope being verified.

One attempt and one link selection can be pending on a route. Async storage
checks are bounded by the attempt cancellation/deadline. Extension dispatch
serializes current-document verification, with at most four waiting operation
frames plus one in flight; overflow/navigation retires the route. This permits
adjacent link-selection/preparation or ACK/state messages without an unbounded
queue. No keys or tokens are put into coordinator state or browser control frames.

The actual receiver transaction now publishes verified own inherited authority
to a local installation callback before its best-effort ACK. Its own key/session
fence survives peer closure and rejects a later own lock/session replacement.
Adoption retains original root sequence, generation and time ceilings, does not
request a fresh password proof, and cannot overwrite a newer explicit OFF.
Source-authority subscriptions trigger readiness after late manual preparation.
Updates caused by the receiver's own installation are deferred until completion
so the coordinator does not cancel its own successful install.

Web persists only nonsensitive scoped link/revision/closing records, using an
origin-wide Web Lock across documents. Missing Web Locks, corrupt bytes, a
conflicting link, a pending closing intent or a disconnect latch prevent use.
A failed local closing write remains blocked until repaired. The Web Identity
adapter adds read/create/activate link and own-activity contract methods; actually
feeding trusted activity into inherited roots is still pending.

**Release gate:** manual lock/logout delivery and reconciliation, durable expiry
barriers and settings/UI are not connected yet. In particular, the coordinator
must not ship until tests prove that a peer with an old root cannot undo a manual
lock/logout or an expired receiver. Runtime integration and successful synthetic
selection tests do not establish that property. No merge/release acceptance is
claimed. Full browser Identity/Entry E2E and the supported artifact matrix remain
required. The actual paired Chromium probe also observes signed-out state sent
and received by both product coordinators and detects local Port disconnects;
it does not supply an account or perform an Identity/MK handoff.


## Explicit manual closing persistence — pre-release increment

The popup's explicit lock/logout commands now pass a manual reason to
SessionManager. Keys are wiped and in-flight session work is cancelled before
waiting for storage; manual logout also removes published memory tokens before
that wait. The worker records closing against existing links for the current
account/API and configured Web origins, even if the peer is closed or the own
client is already locked. Internal security/expiry lock and cleanup do not emit
this manual action. Failed persistence still leaves local keys erased and
returns a failure; it does not claim a durable closing receipt.

Web logoutAndReload records the existing account's pending logout before reload,
using the same origin-wide marker store as the coordinator. It clears own auth
synchronously. A failed marker write prevents reload, and generic auth-failure
clearClientSession does not create shared logout intent. A throwing secondary
cleanup cannot prevent the own auth wipe or the closing record.

The store never creates a link while closing. Logout remains stronger than lock,
disconnect remains a separate latch, and failed writes retain the existing RAM
admission gate until repaired. Receiver-only markers may lack an observed server
revision; revision zero/null preference is a repair hint, not authority for a
mutation. Restart durability is proven only after a successful write.

**Still required before merge:** deliver these intents through own Identity and
the linked peer, reconcile stale CAS receipts and missed actions, and flush old
closings before preparing a fresh manual source authorization. At this increment
pending actions deliberately keep sharing unavailable, including after a new
manual unlock, until that reconciliation is implemented. No peer lock/logout
has been delivered by this increment. Durable expiry barriers, OFF semantics,
activity, settings/UI and the full browser/Identity/Entry matrix remain open.


## Own closing delivery and active-root reconciliation — pre-release increment

Manual Extension lock/logout now delivers the saved intent through its own
captured Identity session before ordinary local logout revocation. Web captures
only its own token fields, clears auth immediately, and delivers before reload.
Network delivery is bounded to two seconds; timeout/conflict leaves the durable
intent pending. A changed own session/environment cancels delivery, and an old
Web logout no longer reloads over a newer login.

The drain reads fresh own preference and link state, then submits the exact
current CAS to the distinct lock/logout/disconnect endpoint. It acknowledges only
the saved intent ID after a receipt. Newer logout decisions and the separate
disconnect latch survive. A fresh authenticated OFF settles manual propagation
without a lock/logout mutation; disconnect remains independent. Missing links,
revoked-link conflicts and failed writes are not silently reset or relinked.
There is no automatic mutation retry after 409.

Both real manual-source compositions drain pending actions before reading the
preference and authorizing a fresh password-derived root. The existing ten-second
proof deadline and own lifecycle checks cover this work. The resulting root's
server sequence therefore follows the completed closing barrier; an inherited
root never performs this manual preparation.

A committed receipt emits only a value-free browser link-invalidated hint.
Active clients independently fetch their own stored link through their own
Identity session and compare its invalidation/logout barriers with the sequence
of their currently installed root. Logout is stronger than lock. Local key wipe
starts before observing the receipt in storage; it invokes ordinary local cleanup
and does not echo another shared mutation. Late responses lose to own account,
token, root/generation and route changes. A peer hint alone never orders a logout.

Repair runs when the route/source becomes available, on an invalidation hint and
every fifteen seconds while the route lives; duplicates are coalesced with at
most one read per second and a two-second pending request deadline. Route teardown
retires subscriptions/timers and leaves a valid own session intact. Best-effort
hint delivery is awaited within the sender's existing deadline before Web reload.

**Remaining release gates:** this monitor requires an in-memory installed own
root. Already-locked/restarted clients, expired own access tokens and independent
multi-document activity/expiry still need completion and focused proofs. Backend
PR #54 supports logout on a revoked link while preserving disconnect and revoking
old linked refresh lineages; client receipt tests retain the local disconnect.
Own input now updates only its own Identity idle authority and durable checkpoint,
with the original absolute/offline ceilings. Full settings/OFF propagation,
disconnect/reconnect UX, canonical browser fixtures and real Identity/Entry E2E on
the entire supported artifact matrix remain required. Synthetic Identity tests
and the paired Chromium channel probe do not close those gates.


## Local preference pause (implementation increment)

The worker's account/API-scoped preference gate fences source admission, receiver
installation and future manual closing delivery. Pausing synchronously cancels
both pending directions; completed own keys and deadlines remain unchanged. Only
a nonsensitive pause ID and its scope are durable. Failed writes retain RAM denial;
late cancellation after a clear restores the persisted denial where storage works.

Local OFF/disconnect admission rejection leaves the browser route available for
an explicit later resumption with fresh state/attempt IDs. Tests cover paused Web
and Extension receivers, late crypto results and unrelated accounts. The shared
Settings surface now calls this gate through the trusted worker command boundary.
Background account-preference repair is connected below; disconnect/reconnect
and the artifact matrix remain release gates.

## Shared account preference settings

Popup and Side Panel mount the same Settings section. The worker reads/writes
Identity's account preference with own JWT, revision CAS and a ten-second budget.
It issues one RAM-only context nonce for the current own settings session; stale
screens cannot mutate a later account/session. UI receives only the preference,
local pause state and that opaque context, never keys or credentials. Command
shapes are strict at the browser messaging boundary. A trusted extension page and
a server-operation lease are checked before dispatch; a set pauses synchronously
before storage or API waits. Page/content bridge messages cannot use this channel.

SessionManager's settings lease borrows only current own tokens, not MK/private
keys. It supports an already locked session that still has its own JWT in RAM.
Lock/logout, login/unlock, refresh and installation of a new own session retire
old leases; a pending browser receiver does not disable Settings, so OFF can
cancel that receiver before key publication. A restarted worker with only the
sealed session must authenticate/unlock before changing the account preference.

Successful ON and OFF settle only their exact local pending-write marker.
Network/storage/CAS/authentication failure or a late cancelled result retains
denial; there is no automatic mutation retry. Boolean preference changes notify
source selection without changing its authority or deadlines. Settings surfaces
refresh on value-free worker hints, focus and a fifteen-second interval; session
hints invalidate old screen results. PL/EN, keyboard switching, two-host state,
signed-out guidance, CAS/retry and real SessionManager lock/receiver races have
focused tests. Local trust display, disconnect/reconnect, native visual acceptance
and the artifact matrix remain open.

## Background account preference repair

Each verified browser route reads the account preference through its own current
Identity tokens on connection, own lifecycle changes and a fifteen-second repair
interval. Only a successful own settings write sends a strict value-free
`preference-invalidated` hint. The recipient performs its own GET; a peer never
supplies an enabled value, account selector or bearer. Observations do not echo
hints. Pending reads and outgoing verification have a two-second budget; reads
coalesce to one in flight plus one pending refresh, at most one start per second.

Account/API-scoped RAM observations reject older revisions. Observed OFF cancels
source and receiver attempts and fences admission and final key installation.
ON can wake a still-valid source, but cannot renew its root, keys or deadlines or
clear a failed-save pause. Existing own sessions stay intact. Own lock/unlock
clears observations; a rejected own JWT forgets only its transient observation,
so it cannot permanently block a later independently authorized receiver.
Network failure retains known OFF. Fresh Identity consume/commit authority and
the durable local pause/link/expiry barriers remain required for any handoff.

Worker reads use the token-only settings lease even while keys are locked, and
dispose it on every completion or failed initial read. A restarted worker with
no own JWT cannot use a peer hint as authority. Locked/restarted closing repair,
real Identity/MK/Entry E2E and the complete browser artifact matrix remain gates.
