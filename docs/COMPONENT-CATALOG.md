# Popup component catalog

Read this map before changing popup UI, then `POPUP-DESIGN.md`, the chosen source
and one current consumer. Paths below are relative to `src/popup/`. Props belong
to those TypeScript modules; this inventory does not define a second API.
The root `design/workbench/COMPONENTS.md` routes the offline mockup workflow.

## Existing controls and composition

| Need | Source | Reuse boundary |
|---|---|---|
| App and preferences | `App.tsx`, `preferences.tsx` | Mount the real app/providers in previews; replace transports only. |
| Workspace, tabs and footer | `screens/UnlockedScreen.tsx`, `components/Header.tsx`, `components/ScrollableTabs.tsx` | Preserve original shell and exported `UnlockedFooter`; no copied shell JSX. |
| Action | `components/Button.tsx` | `accent` red; `contrast` neutral outlined Login; `positive` green text; `danger` red text; `subtle` and `ghost`. Supports `loading`, `disabled`, `block`. Do not translate web variant names blindly. |
| Labelled field | `components/FormInput.tsx` | Label, error and input attributes. Reuse the actual form's secret reveal controls. |
| Search | `components/SearchBar.tsx` | Existing global search, not a new raw input. |
| Filter / policy choice | `components/FilterSelect.tsx` | Existing custom menu; choose single/multiple semantics from its props and consumer. Multi-select stays open on selection. |
| Entry choice | `components/EntryAutocomplete.tsx` | Existing resource selection. `showIcon` shows the selected item's mark in the field; `logo`/`logoMono` show a provider mark for items without an icon; `onCustomValue` accepts free text (sign-in account); `plain` items have no icon. |
| Capture review | `capture/CaptureReview.tsx` | Notice/review/saved shell for capture. Alternative destinations ("Add to", "Change entry", "Create a new entry/card", "Edit entry") go in `menuActions` above the site mute in the Dismiss arrow menu; never as extra fields or buttons in the review. The saved stage has no heading: the vault leads the card detail, "Saved"/"Updated" takes the Dismiss half with an arrow menu "Go to entry", and in the capture frame a 6 s countdown under the logo strip closes it (paused on hover or an open menu). |
| Inline autofill menu | `content/isolated/inline-autofill.ts` | In-page suggestions under a login field. Header matches the in-page notifications (gradient, brand grain, close button); each row shows the name and "vault · account" on one line with a bordered arrow for fill-and-log-in, which turns into a spinner while working. The list closes itself after a 12 s countdown under the header, paused on hover or focus. Loading shows one placeholder row; the panel then grows to the list with a height animation and a row fade-in. |
| Inline generator offer | `content/isolated/generator-suggestion.ts` | One line "Use strong password: value" with regenerate; footer is the split Dismiss (arrow menu holds Password options) plus Use password. No close button; Escape and Dismiss close it. The popup has no separate "password change detected" banner: the Generator tab fills the detected form directly. |
| Refresh / copy | `components/RefreshButton.tsx`, `components/CopyButton.tsx` | Preserve pending/clipboard behavior. |
| Entity identity | `components/EntryIcon.tsx`, `components/AgentIcon.tsx`, `components/EntryGlyph.tsx` | Use the public asset resolver and glyph fallback; no arbitrary remote image URLs. |
| Icon selection | `components/EntryIconPicker.tsx` | Existing glyph/catalog picker and supported presentation colors. |
| Public asset loading | `components/PublicAssetImages.tsx` | Shared image resolution; reuse through the existing identity components. |
| TOTP badge | `components/TotpBadge.tsx` | Existing TOTP affordance; keep secret handling in its owner. |
| UI glyph | `components/PopupIcon.tsx` | Central glyph map; no remote icon fonts. |
| Entry list and row | `components/EntryList.tsx`, `components/EntryRow.tsx` | Existing selection, truncation and icon geometry. |
| Entry detail / fields | `components/EntryDetail.tsx`, `workspace/EntryFields.tsx`, `workspace/EntryTotpField.tsx` | Original identity/data/navigation cards; do not fork a read-only form. |
| Entry-scoped navigation | `components/EntryScopeHeader.tsx` | Entry identity plus Back; preserve Vault/Entry scope. |
| Relative dates | `components/RelativeTime.tsx` | Localized relative value and exact timestamp title. |
| Settings group | `components/SettingsSection.tsx`, `screens/SettingsScreen.tsx` | Reuse section and existing settings rows. |
| Loading | `components/ListSkeleton.tsx`, `components/LoadingSkeleton.tsx`, `components/Spinner.tsx` | Choose the existing state for the affected surface. |
| Error | `workspace/WorkspaceError.tsx` | Existing workspace error treatment. |
| Inbox / grant approval | `workspace/GrantsPanel.tsx` | Reuse policy form, duration/operation/field controls and decision actions; they are not separate exported design controls. |
| Sharing | `workspace/SharingOverview.tsx`, `workspace/SharingPanel.tsx` | Overview/detail and Entry-context creation respectively. |
| Logs / recent activity | `workspace/AuditPanel.tsx` | Full list and `preview` mode use the same rows; pass existing scope/target and navigation callbacks. |
| Create Entry | `entries/AddEntryForm.tsx` | Pinned Back/type header, fields and footer; preserve the original composition. In capture, `compact` shows the essential fields (password; card holder, `MM/YYYY` expiry and CVC; API key value) and a `slot` (Vault choice) beside the Dismiss-styled "More" button, which reveals the remaining fields with the review expansion motion. `usernameOptions` renders the sign-up identity choice as one dropdown. |
| Generator | `generator/GeneratorPanel.tsx` | Existing password generator. |

## CSS-owned patterns

Status chips, identity cards, checkbox rows and warning/destructive sections are
currently composed inside their owning screens. They are not exported `Chip`,
`Zone` or web `DangerZone` components. Reuse the existing composition and CSS;
if another consumer needs an extraction, agree the missing pattern first and
share one implementation between product and mockup.

Read the styles in load order: `popup.css`, `redesign.css`, with `viewport.css`
for native sizing. Later overrides matter: do not copy an early base token or
selector and assume it is the rendered design. Use `--cv-*` variables and existing
classes; `POPUP-DESIGN.md` records selection, spacing and action semantics.
Web and extension have separate component APIs; the workbench reuses each
product's own modules, not a shared cross-product component package.

When a control is added, renamed or removed, update this catalog and the root
workbench map in the same task. Never mark a mockup-only control as production-ready.
