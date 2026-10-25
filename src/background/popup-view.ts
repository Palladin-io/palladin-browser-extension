import { isPopupViewCommand, type PopupViewSnapshot, type PopupViewState } from "../shared/messaging/popup-view";

export const POPUP_VIEW_TTL_MS = 5 * 60_000;

/** Owned by the unlocked worker session; never written to browser storage. */
export class PopupViewStore {
  private state: PopupViewState | null = null;
  private generation = crypto.randomUUID();
  private unlocked = false;
  private expiresAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  unlock(): void {
    this.lock();
    this.unlocked = true;
  }

  lock(): void {
    this.unlocked = false;
    this.generation = crypto.randomUUID();
    this.clear();
  }

  handle(raw: unknown): PopupViewSnapshot | null | undefined {
    if (!isPopupViewCommand(raw)) return undefined;
    if (!this.unlocked) return null;
    if (Date.now() >= this.expiresAt) this.clear();
    if (raw.type === "popup/view/set") {
      // A delayed write from before lock must never revive the old view.
      if (raw.generation !== this.generation) return null;
      this.state = structuredClone(raw.state);
    }
    if (this.state !== null) {
      clearTimeout(this.timer);
      this.expiresAt = Date.now() + POPUP_VIEW_TTL_MS;
      this.timer = setTimeout(() => this.clear(), POPUP_VIEW_TTL_MS);
    }
    return { generation: this.generation, state: this.state === null ? null : structuredClone(this.state) };
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state = null;
    this.expiresAt = 0;
  }
}
