# Extension workspace redesign

The unlocked popup uses a 780 × 580 layout; authentication and first-run guidance use a 420px-wide compact layout whose height follows the current form, resizing in the existing native popup. Both are constrained to the browser's available
viewport height. The native Side Panel adapts to its available width. The Vault
has separate list and details columns, with a neutral selected row, Entry icon,
login/share actions, on-demand field reveals, TOTP and links to scoped management.
The generator is a header action; Add Entry is the primary plus button. Existing
sign-in, second factor, unlock, capture, settings and shared-unlock flows remain.

The Inbox view lists grant requests/history and reviews an authoritative request
before approval. Approval verifies the signed encrypted reason, re-opens the current
Entry, binds the envelope to the requested Agent and reviewed revision, and supports
time, use-count or until-revoked policies. Granular fields and methods are explicit;
Script execution uses the same package builder as the existing credential writer.
Deny and revoke use their existing backend endpoints. The Inbox tab shows a
pending-request count. Authenticated SignalR notifications carry only a value-free
workspace invalidation to the popup, which fetches authoritative REST state; a
30-second foreground poll repairs missed notifications. An open review is preserved.

Sharing sends a complete encrypted snapshot. Supported options are 1/24/72/168 hours,
unlimited or 1–100 receipts, anyone-with-link or up to 20 distinct named recipients,
password/PIN protection, and first-receipt notifications. Each named recipient receives
an independent link. A failed create retries the same challenge and ciphertext; a
partially completed recipient batch retries only unfinished recipients. Links and
retry state stay in memory and are discarded on view close or lock. The list supports
revocation and changing/removing protection. Existing links cannot be recovered.

Logs use the organization audit endpoint with filters and cursor pagination. Entry and
Vault labels are resolved from unlocked metadata, while human actors use one memory-only
current/former member directory with at most one missing-ID repair per unlocked surface.
Unknown event types remain visible with a neutral presentation.

## Security boundary

Only the existing trusted extension-page handler accepts `workspace/*` messages. Its
strict command schema accepts specific operations and bounded user input, never an
arbitrary URL or bearer token. The worker owns all API traffic, keys and crypto. Session
identity and server configuration are fenced across asynchronous work; locking aborts
requests and clears retry state. Approval validates envelope coordinates independently
of the supplied envelope. Plaintext is returned only to the extension-owned selected
Entry/review UI. No workspace material is stored or logged.

## Dependency and delivery gate

The implementation requires the additive shared SDK Entry-sharing and signed-reason
APIs in crypto PR27. They must pass review and be released
through the SDK's signed-tag workflow before updating the extension's exact registry
version and lockfile. Do not merge or distribute an extension built against a locally
substituted SDK. The current extension manifest/lockfile points to registry version 0.12.0, which does not export these APIs.

Local candidate verification uses SDK main e759c95 combined with sharing candidate bbf281d, built in an isolated worktree and copied into the ignored
`node_modules/@palladin/crypto/dist/` directory; this is development evidence, not a
reproducible release artifact. Repeat the checks from `npm ci` after the registry
version is pinned. No package or browser-store release is performed by this change.

## Validation

- Worker tests cover untrusted commands, fixed routes, lock/server changes, late results,
  ciphertext-only share requests, idempotent retries, request/Entry coordinates, stale
  revisions, method expansion and invalid signed reasons.
- UI tests cover delayed secret responses after unmount, named-recipient partial retries,
  directory repair and the existing login/generator/capture behavior.
- `node tests/browser/workspace.mjs` drives the real Chromium popup against disposable
  synthetic provider fixtures: sign-in, create Entry, details, create/revoke share,
  audit identity, lock/unlock and light/dark/settings screenshots. It does not establish
  staging acceptance, Firefox/Safari runtime support or store readiness. Theme selection
  uses an ordinary test DOM change event; security-sensitive actions use trusted clicks.

## Asset provenance

Inter Latin/Latin Extended variable WOFF2 files and `INTER-LICENSE.txt` are reused from
the first-party landing page (SIL Open Font License). `brand-grain.svg` is the first-party
landing texture. The extension's existing reviewed T02 logo source and manifest icons
are unchanged.

The workspace surface treatment follows landing VaultPresentations/TransferScenes: thin tab separators, a short static active marker, raised neutral cards and subtle shadows. Popup and Entry type icons use the locally bundled Lucide React package (ISC), matching the web icon family. No remote icon font or script is loaded.

Auth uses the same horizontal shield/wordmark header and full-surface grain as the
unlocked workspace, with settings on the right. Bundled Inter renders the 19px
wordmark at weight 800 with -0.01em tracking. Rotating welcome lines are not used.
Native acceptance verifies the loaded font, compact form dimensions and stable
unlocked dimensions across Settings.

Sharing overview uses a single aggregate page and scroll continuation. Effective
active links precede inactive links; each group is newest first. Status tags and
edit/revoke icons keep rows compact; dates remain in details. Protection editing
opens directly, revocation asks for confirmation, and the web action opens the
selected Entry in the configured panel. Backend PR80 provides matching global
keyset ordering. This is a live list: lifecycle changes can move links between
pages, so the client deduplicates IDs and refreshes from the beginning to repair.
