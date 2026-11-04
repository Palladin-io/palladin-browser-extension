# Popup component standard

The extension uses the accepted Palladin web-panel component treatment, at native
popup density. Source: `src/popup/redesign.css`, shared React controls under
`src/popup/components/`. Do not restyle worker permissions or secret presentation
as part of visual changes.

- Tabs and navigation use a neutral text-colour outline for selection, rounded
  corners and no coloured underline or left stripe. The tab group retains its
  own full-width frame with horizontal boundaries, flush with both popup edges.
  The strip has no outer margin or rounded outer corners. In narrow side panels
  the group scrolls horizontally without a visible scrollbar. Edge fades and
  translated arrow buttons indicate hidden tabs; the fade masks the scrolling tabs
  directly, without reserving a blank margin; arrows disappear at each end.
  Trackpad scrolling and keyboard focus remain available.
- Status chips use a neutral surface and border, 6px corners, 11px medium text.
  Semantic status colour belongs to the text. Descriptive metadata stays neutral.
- Primary actions use the darker `--cv-primary-hover` red. Positive access approval
  uses `Button variant="positive"`: neutral surface/border and green text. Danger
  actions retain red text on the same neutral surface. Confirmations keep labels.
- Sharing creation is available only from the Entry context through its labelled
  share-icon action, never from the global sharing overview. Logs and the
  sharing overview have compact filter/action toolbars without repeated headings.
  Logs filter on the server. Sharing filters loaded links locally, explicitly
  identifies this scope and keeps pagination available for older links.
- Identity icons retain their framed, neutral surface. Grain belongs to the
  content canvas, not the logo or navigation rails. The texture and 180px tile
  match the panel, with a feathered diagonal band: 92% light / 93% dark cover.
- The native popup starts at 400 x 360 CSS pixels for loading, onboarding,
  sign-in and unlock. The unlocked workspace expands to 780 x 580; standalone
  settings use 400 x 580. Phase changes resize immediately without dimension
  transitions. Side-panel bounds remain browser-owned.


## Verification boundary

Component tests cover filters and access flows; `tests/browser/workspace.mjs`
contains native geometry assertions across auth and workspace. Browser automation
must run in its approved environment. A browser-tab component preview verifies
appearance, not native-popup startup timing or Firefox/Safari runtime support.

Inbox details place Agent identity on the left and resource identity on the right
inside one card. The decrypted request reason spans both columns below them;
compact date metadata stays in a separate two-column card. Agent images use the
existing selected-API public asset resolver, with a neutral glyph fallback.
Inbox rows use a centered 38px Agent icon and place the short Pending status
beside the resource name. Dates stay in the detail metadata, not the list. Identity icons sit beside names, never above. On narrow surfaces the
two identity sections stack while retaining horizontal icon/name alignment.
The full timestamp remains in the detail metadata.
Sharing uses the same master/detail rail. Link actions and revocation confirmation
belong in the selected detail, keeping every list row equally compact.
Approval uses the web/mobile four-column quick-duration grid (5/15/30 minutes,
1/2/6/12/24 hours), followed by a custom date control. Selected durations and
method/field controls use neutral outlines and red checkbox accents. Deny (red
text) and Approve access (green text) sit side by side, in that order, above the
optional denial reason. Deny is a non-submit action. The existing policy defaults
and worker permission boundaries remain unchanged.

Master lists (Vault, Inbox, Sharing) share 12px row padding, 8px gaps, 38px
identity icons, 13px titles and 11px secondary text. Inbox and Sharing put status
beside the secondary text; dates remain in details. Vault's multi-select trigger
matches the other filters (36px height, 6px corners, neutral input surface).
Inbox detail identities use 40px icons beside names. Card padding, inter-card gaps
and form-group gaps are 16px; label-to-control gaps are 8px.

Workspace status/event filters and the grant-policy picker use the custom
FilterSelect menu, matching Vault's neutral surface, spacing and red checkmark.
Options support arrow/Home/End navigation, Escape, Tab exit and outside dismissal;
Vault keeps its existing multi-select semantics. Detail scrollers reserve a stable
scrollbar gutter. Request reasons stay one line with ellipsis and a full native
hover tooltip; keyboard focus expands the text. Sharing details use the same
identity, metadata and action cards with 16px gaps as Inbox.

Workspace list filters are multi-select: choosing or deselecting an option keeps
the menu open; All clears the selection. Status/event selections are OR filters.
Inbox and Audit preserve server filtering with a cursor per selected value and a
merged chronological list; changing scope drops the old cursor set. Sharing keeps
its explicitly labelled loaded-link filter. The grant policy picker remains
single-select because policies are mutually exclusive.
Entry details reuse the identity card and shadow-free data/navigation cards.
Sharing's status sits at the top-right of its identity card; management buttons
use neutral bordered surfaces without shadows, retaining red for revocation.

Grant approval keeps every Agent-requested operation visible and initially checked.
There is no inferred preferred method when several were requested. Unrequested
methods appear unchecked and disabled under collapsed Other operations, with a
localized explanation that a separate request is required. Never widen the worker's
requested-method boundary merely to populate this disclosure.

Entry-context sharing uses the same shadow-free identity card as Entry details.
The back arrow stays left and resource identity aligns right, with its icon after the name. Recipient,
protection, expiry, receipt and notification controls share one bordered card
with separated rows, without an introductory snapshot notice. Custom single-select menus expand within the form
flow; the whole detail pane scrolls so menus are not clipped by a small fieldset.
Cancel and Create link share a bottom action row.

Entry-detail Agent access and Logs actions open their workspace tabs scoped by
both Entry and Vault IDs. Clicking the corresponding main tab resets that scope.
This is covered through UnlockedScreen and the worker-message transport, not
only the synthetic preview navigation.

The unlocked footer places the manifest version after Open web panel with a
vertical separator; Lock and Sign out stay right-aligned. Split-view settings do not duplicate it; standalone locked settings
retain the version because the workspace footer is absent.

Inbox and Sharing list titles/resource names remain one line with ellipsis and
a full native hover title. Grant approval groups limit/duration, operations and
fields into separated sections within one form card, reusing bordered checkbox
rows and full-width custom selects. Permission defaults remain unchanged.

Detail identity titles also use a single ellipsized line with a full hover title,
so long Agent/resource names do not increase the identity-card height.

Entry-scoped Inbox, Logs and Sharing replace global filters with EntryScopeHeader
(identity plus Back). Back restores the selected Entry; main tabs clear scope.
Sharing uses workspace/shares with both Vault/Entry IDs, not a local filter of
the global paginated list. Entry detail keeps both the header Share action and the Share navigation row
for creation, plus a separate Sharing navigation row for existing links.
Create Entry uses a pinned Back/type-selector header, one scrolling field card
and pinned Cancel/Save actions, matching the web form hierarchy. Type and back
actions are disabled while saving; drafts stay memory-only and clear on success.

Create Entry places the type selector at the right of Back, the framed icon
selector beside Name, and Username/Password in equal columns (stacked below
450px). Only the field body scrolls; the outer form reserves no second gutter.
Entry Login uses the neutral `contrast` button. Server-setting checkboxes reuse
bordered settings rows and the dark-red checked accent.

The icon dialog offers the web's Entry glyph vocabulary, six presentation colors,
and a searchable public service catalog. Selection is saved in encrypted Entry
presentation with icon/color Agent disclosure still disabled. The popup sends
only an allowlisted glyph or catalog ID and a six-digit hex color; the worker
resolves catalog metadata from the selected API inside the initiating session
fence. Rendering never uses an arbitrary URL supplied by the popup or ciphertext.
Custom image upload is still pending: installed @palladin/crypto 0.13.0 does not
export the web's encrypted presentation-asset container operations. This picker
is not yet full web parity; upload/read support must use the shared crypto package.

Unlock uses a separate compact 400×292px viewport (348px with the optional
biometric action); sign-in remains 400×360px. Validation can scroll inside the
unlock form instead of clipping actions. The neutral contrast Login button is
outlined with transparent fill and a subtle hover surface, not a solid inverse
fill. Footer link/version share a 12px/18px baseline. Inbox/Sharing use one
1px `--cv-border` master divider; the detail adds no second border.

Inbox, Sharing and Logs cache list responses in the unlocked popup's
WorkspaceClient for 60 seconds from successful completion. Switching tabs reuses
fresh pages and coalesces concurrent identical reads; expiry is checked on the
next read, without a new background polling timer. Cache keys include filters,
Vault/Entry scope and cursor; the map is bounded to 100 pages and disappears
with the unlocked popup. Secrets, decrypted reasons, approval previews and
mutations are never cached by this mechanism.

Worker realtime workspace notifications and changed grant summaries invalidate
Inbox/Logs. Successful grant decisions invalidate Inbox/Logs; successful share
creation, revocation or protection changes invalidate global/scoped Sharing and
Logs. Mounted lists refresh while retaining existing rows. Manual Refresh
bypasses freshness. Invalidation drops pending entries as well; their late
responses cannot repopulate the cache. Authoritative mutation/review checks
remain in the worker and backend.

Sharing detail actions share one row at workspace width and wrap only in the
narrow layout. Created/expiry/decision timestamps use localized relative time
with the exact date in a hover title. Shared by displays You because both share
list endpoints return only links created by the authenticated user.

Inbox and Sharing details include up to ten recent matching audit events using
the same padded rows as Logs. The heading and log list sit directly on the
detail canvas without an additional outer card. Show more sits below the list only when it has
more than ten matching events or the server reports another page. Matching requires the same Vault and exact grantId/shareId
metadata; entry scope alone must not mix different grants or links. The current
API has no grant/share filter, so previews inspect only the first cached page.
An empty preview with older pages explains this limit. Dedicated Logs retains
the target and offers explicit Load more, without automatically scanning all
history. Global Logs clears that target and retains its usual pagination.

Sharing detail actions contain only Change protection and Revoke link. The legacy
All links action and its old list have been removed; unavailable actions do not
leave an empty action card. Entry Sharing navigation still opens the current
scoped Sharing overview.

A Credential's federated sign-in method is a separate shadow-free data card below
the Entry fields, 16px apart; Change uses the ghost action and Forget the neutral
danger action.

Entry details reuse the recent-activity preview, scoped by Vault and Entry.
Show more is a quiet text action below the list (with keyboard focus styling),
not a bordered button; it opens the dedicated Logs view for the same scope.

Audit rows use the web panel's 3px semantic left border, colored with the existing
event token in full Logs and embedded previews. Footer icon, label and version
are vertically centered together; the label and version retain equal line-height.
