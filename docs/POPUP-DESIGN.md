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
- Sharing creation uses an accessible, labelled share-icon button. Logs and the
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

Inbox details separate the Entry heading, Agent identity/status, request reason and
compact two-column metadata. Cards use the shared surface and border; the master
rail has an explicit divider. List status chips sit below Entry names beside the
short date; the full timestamp remains in the native tooltip and detail metadata.
