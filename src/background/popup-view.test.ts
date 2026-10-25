import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPopupView, isPopupViewCommand } from "../shared/messaging/popup-view";
import { POPUP_VIEW_TTL_MS, PopupViewStore } from "./popup-view";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function save(store: PopupViewStore) {
  const snapshot = store.handle({ type: "popup/view/get" })!;
  const state = { ...emptyPopupView(), query: "example", selected: { vaultId: "vault", id: "entry" } };
  const command = { type: "popup/view/set", generation: snapshot.generation, state };
  store.handle(command);
  return command;
}

describe("PopupViewStore", () => {
  it("restores navigation for five minutes and renews on returning", () => {
    const store = new PopupViewStore();
    store.unlock();
    const command = save(store);
    vi.advanceTimersByTime(POPUP_VIEW_TTL_MS - 1);
    expect(store.handle({ type: "popup/view/get" })?.state).toEqual(command.state);
    vi.advanceTimersByTime(POPUP_VIEW_TTL_MS - 1);
    expect(store.handle({ type: "popup/view/get" })?.state).toEqual(command.state);
    vi.advanceTimersByTime(POPUP_VIEW_TTL_MS);
    expect(store.handle({ type: "popup/view/get" })?.state).toBeNull();
  });

  it("clears on lock and rejects delayed writes from the previous unlocked session", () => {
    const store = new PopupViewStore();
    expect(store.handle({ type: "popup/view/get" })).toBeNull();
    store.unlock();
    const command = save(store);
    store.lock();
    expect(store.handle(command)).toBeNull();
    store.unlock();
    expect(store.handle(command)).toBeNull();
    expect(store.handle({ type: "popup/view/get" })?.state).toBeNull();
  });

  it("does not carry state or accept old writes after a worker restart", () => {
    const old = new PopupViewStore();
    old.unlock();
    const command = save(old);
    const restarted = new PopupViewStore();
    restarted.unlock();
    expect(restarted.handle(command)).toBeNull();
    expect(restarted.handle({ type: "popup/view/get" })?.state).toBeNull();
  });

  it("rejects malformed and oversized messages and secret-bearing extra fields", () => {
    const state = emptyPopupView();
    for (const bad of [
      { ...state, password: "not-allowed" },
      { ...state, query: "x".repeat(4097) },
      { ...state, selected: { vaultId: "vault", id: "entry", password: "secret" } },
      { ...state, scrollTop: Infinity },
      { ...state, visibleCount: -1 },
      { ...state, view: "unknown" },
    ]) expect(isPopupViewCommand({ type: "popup/view/set", generation: "session", state: bad })).toBe(false);
    expect(isPopupViewCommand({ type: "popup/view/set", generation: "session", state })).toBe(true);
    expect(isPopupViewCommand({ type: "popup/view/get", password: "extra" })).toBe(false);
  });
});
