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
- The native popup reserves 780 x 580 CSS pixels through `viewport.css` before
  React or the worker reply. Loading, login, unlock and workspace retain those
  bounds, without width/height transitions. Auth forms remain narrow. This trades
  extra auth whitespace for a stable opening. Side-panel bounds remain browser-owned.

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
