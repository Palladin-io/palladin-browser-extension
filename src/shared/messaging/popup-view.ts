/** Navigation only. Search text is potentially sensitive and must remain in RAM. */
export interface PopupEntryRef { vaultId: string; id: string }
export interface PopupViewState {
  query: string;
  view: "vault" | "generator" | "add-entry" | "logs" | "shares" | "grants" | "settings";
  selected: PopupEntryRef | null;
  scope: PopupEntryRef | null;
  vaultFilter: string[] | null;
  visibleCount: number;
  scrollTop: number;
}
export interface PopupViewSnapshot { generation: string; state: PopupViewState | null }
export type PopupViewCommand =
  | { type: "popup/view/get" }
  | { type: "popup/view/set"; generation: string; state: PopupViewState };
export function emptyPopupView(): PopupViewState {
  return { query: "", view: "vault", selected: null, scope: null, vaultFilter: null, visibleCount: 100, scrollTop: 0 };
}
export function isPopupViewCommand(raw: unknown): raw is PopupViewCommand {
  if (typeof raw !== "object" || raw === null) return false;
  const command = raw as Record<string, unknown>;
  if (command.type === "popup/view/get") return Object.keys(command).length === 1;
  if (command.type !== "popup/view/set" || typeof command.generation !== "string" || command.generation.length > 64) return false;
  if (!Object.keys(command).every((key) => ["type", "generation", "state"].includes(key))) return false;
  if (typeof command.state !== "object" || command.state === null) return false;
  const state = command.state as Record<string, unknown>;
  return Object.keys(state).length === 7
    && typeof state.query === "string" && state.query.length <= 4096
    && ["vault", "generator", "add-entry", "logs", "shares", "grants", "settings"].includes(state.view as string)
    && validEntry(state.selected) && validEntry(state.scope)
    && (state.vaultFilter === null || (Array.isArray(state.vaultFilter) && state.vaultFilter.length <= 1000 && state.vaultFilter.every(validId)))
    && typeof state.visibleCount === "number" && Number.isSafeInteger(state.visibleCount) && state.visibleCount >= 100 && state.visibleCount <= 1_000_000
    && typeof state.scrollTop === "number" && Number.isFinite(state.scrollTop) && state.scrollTop >= 0 && state.scrollTop <= 100_000_000;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function validEntry(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return Object.keys(ref).length === 2 && validId(ref.id) && validId(ref.vaultId);
}
