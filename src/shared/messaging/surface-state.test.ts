import { describe, expect, it } from "vitest";

import {
  isSurfaceStateEvent,
  sessionChanged,
  vaultChanged,
} from "./surface-state";

describe("extension surface state events", () => {
  it("accepts only value-free session and Vault invalidations", () => {
    expect(isSurfaceStateEvent(sessionChanged("locked"))).toBe(true);
    expect(isSurfaceStateEvent(vaultChanged())).toBe(true);
    expect(isSurfaceStateEvent({
      channel: "palladin.surface-state.v1",
      type: "surface/session-changed",
      status: "unlocked",
      password: "must-not-travel",
    })).toBe(false);
  });

  it("rejects unknown state and unrelated messages", () => {
    expect(isSurfaceStateEvent({
      channel: "palladin.surface-state.v1",
      type: "surface/session-changed",
      status: "totp",
    })).toBe(false);
    expect(isSurfaceStateEvent({ type: "surface/vault-changed" })).toBe(false);
  });
});
