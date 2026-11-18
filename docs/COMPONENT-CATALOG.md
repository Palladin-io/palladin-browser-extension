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
| Entry choice | `components/EntryAutocomplete.tsx` | Existing resource selection. |
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
| Create Entry | `entries/AddEntryForm.tsx` | Pinned Back/type header, fields and footer; preserve the original composition. |
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
