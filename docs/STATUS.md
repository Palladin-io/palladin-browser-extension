# Project status and restart gates

The repository contains development artifacts for one shared extension core:
Chromium-family MV3, Firefox, and a Safari conversion foundation. It includes
canonical Vault Protocol 2 user autofill and explicit write paths. Agent Inject
keeps its separate provider contract but its Native Messaging transport is
fail-closed until the user explicitly verifies and pins the local runtime. It
remains pre-production and has no supported production version until every
release gate below is complete.

`main` remains the authoritative product surface. Work starts from current
`main` and arrives through normal review; historical prototype branches are not
release candidates.

## Development baseline

- One buildable source tree with a locked dependency graph.
- The shared cryptographic dependency is the exact public registry release
  `@palladin/crypto@0.4.0`, published from signed tag `v0.4.0` with npm/Sigstore
  provenance. No temporary Git SHA or extension-local crypto wire remains.
- CI and local tests cover messaging, session lock/wipe, ciphertext-only cache,
  canonical writes for credentials, keys, scripts and cards, domain matching,
  credential/card fill, payment-field
  exclusions, exact-document Login navigation, public catalog icon rendering,
  Vault-name list context, isolated closed-Shadow-DOM login suggestions, Agent fill,
  replay rejection, BFCache port restoration, manifest
  CSP validation for the bundled crypto WebAssembly, and logging redaction.
- One Chromium artifact targets Chrome, Edge, Brave, and Opera; Firefox and
  Safari use manifest overlays over the same core.
- The popup defaults to the production API. Settings can select staging,
  localhost, or an HTTPS self-hosted API through an exact optional host
  permission. A change signs out and clears the local encrypted cache, and
  stored session tokens and pending TOTP challenges are bound to their issuing
  API URL. A generation barrier drains old-host operations before the durable
  switch and serializes exact-origin permission cleanup.
- English and Polish cover the complete popup and manifest metadata. Language
  defaults to the browser UI language (English fallback) with an explicit
  override. Theme defaults to the system color scheme and supports persistent
  Light/Dark overrides using the web panel's reviewed `--cv-*` tokens.
- First use shows one EN/PL guidance screen explaining that overlapping
  password managers can duplicate icons and prompts. It offers explicit links
  to browser-owned password and extension settings, persists only a versioned
  `completed` marker, and does not repeat after continuation. No target requests
  `management`, enumerates installed extensions, or claims that a competing
  manager was detected.
- Copy is available only in the Chromium artifact, where the reviewed offscreen
  TTL wipe exists. Firefox and Safari hide Copy and reject copy commands before
  decrypting a value.
- Card storage/autofill supports cardholder, PAN, expiry, billing, and notes.
  Canonical custom fields stay neutral and are never inferred as payment
  authentication data; there is no dedicated field or heuristic for it.
- The Native Messaging host name and authenticated session framing are explicit
  and tested. No `session.open` is sent without a pinned signing key/fingerprint.
- The extension-owned popup accepts only the strict out-of-band pairing bundle
  printed by `palladin browser install`, derives and verifies the public-key
  fingerprint, and requires explicit user confirmation before persisting the
  public pin. Saving connects; unpairing disconnects and disposes immediately.
  After a durable non-secret intent succeeds, interrupted clear/re-pair writes
  restart fail-closed. An in-memory mutation barrier suppresses new work and
  drains already-dispatched fills before pairing success. If both the intent
  write and fallback active-pin removal fail (a successful fallback restarts
  unpaired), the current worker remains suppressed and the user must retry
  before restarting; no durable revocation guarantee is claimed for total
  storage failure. Plaintext and TOFU fallbacks do not exist.
- Development compatibility targets current Chrome, Chromium, Brave, Edge, and
  Opera MV3 builds. Store certification and version support are not yet claimed.
- Inline login suggestions are implemented beside standard username/email
  controls whose owning form also contains a usable password field. Standalone
  email or username forms do not receive a launcher. The menu receives only
  exact-host and same-registrable-domain
  Credential presentation data (label, username, domain, Vault and match scope),
  never a password/TOTP/custom value. Related-host accounts are labelled and
  require a one-shot explicit entry choice; they are never auto-selected. While
  unlocked, an empty standard form is intentionally filled once with the first
  exact-host account without requiring focus or a user gesture. A successfully
  selected exact account is preferred for that exact host until lock, using
  memory only; otherwise name ordering determines the first account. Automatic
  fill never submits or overwrites an existing value. See
  [`AUTOFILL-POLICY.md`](AUTOFILL-POLICY.md). Scripted focus alone cannot
  repeat or submit a fill. A separate
  explicit enter-arrow action fills and submits the owning form. The final
  pre-write gate remains bound to the exact live host, document, and isolated-
  world identity of the discovered username/password/form tuple.
- Repeated website entries are grouped by host. Expanding a group decrypts only
  its usernames for transient extension-owned display and shows each account's
  Vault; the collapsed group shows only its login count and the persistent
  metadata cache remains username-free. Long lists append 100 grouped rows at a
  time as the user reaches the end.
- Vault synchronization uses strict value-free SignalR invalidations for
  targeted authenticated REST delta fetches. Duplicate/out-of-order hints are
  coalesced, equal-version removal tombstones dominate updates, and reconnect
  or unlock performs a full all-Vault repair. The 15-minute unlocked alarm is a
  repair fallback for MV3 suspension or transport loss, not routine polling.
  Active-tab navigation only rebuilds the local site projection: it preserves
  list UI state and does not start another backend sync.
- Add entry writes neutral text, multiline, and concealed custom fields through
  the same canonical Protocol 2 path, with Agent access defaulting to `never`;
  users can reorder those fields without changing canonical IDs or values.
- A Credential exposes one primary **Log in** action: it fills and submits the
  current exact HTTPS form when available, otherwise opens the stored host and
  fills and submits the new browser-authenticated document. Ordinary **Fill**
  paths never inherit this submit intent. Entry management is a separate extensible row
  beginning with **Open in Palladin**; the duplicate Credential **Fill** action
  is not shown.
- The complete Vault can run in a persistent Chromium side panel or Firefox
  sidebar through target-specific manifest/API adapters over the shared App.
  The popup remains the compact launcher and exposes a localized user-gesture
  control to open the panel. Safari intentionally retains the popup. Installed
  store/browser certification remains a release gate.
- An open side panel participates in the same value-free 20-second liveness
  channel as content scripts, preventing routine MV3 retirement from discarding
  memory-only keys while the user is actively using the panel. It does not reset
  the configured auto-lock deadline.
- Session and keys remain fail-closed. Compatible worker retirement, Reload,
  update, disable/enable, and browser restart preserve account sign-in only as
  one authenticated, password-sealed `storage.local` envelope. Tokens are
  ciphertext and keys remain memory-only, so reopening returns to **Locked**,
  never **Unlocked**. Wrong passwords preserve a valid envelope; unsupported,
  expired, foreign-runtime/server, or verifiably tampered envelopes fail closed.

## Additional gates for any release

- independent security review of the consolidated implementation;
- threat model updated from observed code rather than prototype assumptions;
- reproducible production build and reviewed store manifest;
- dependency audit, SBOM, artifact hashes, and build provenance;
- browser-store signing, update, rollback, and incident-response procedures;
- end-to-end tests against a compatible public Palladin API contract;
- trusted-runtime pairing with an independent user-verification channel and
  installed-browser Native Messaging tests;
- release notes that distinguish implemented behavior from future work.

Until every release gate is complete, documentation and UI must continue to use
experimental language and must not ask users to trust the extension with real
credentials.
