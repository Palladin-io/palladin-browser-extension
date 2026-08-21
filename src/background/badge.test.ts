import { describe, expect, it, vi } from "vitest";

import { applyBadge, badgeForStatus, type BadgeApi } from "./badge";

describe("badgeForStatus", () => {
  it("clears the badge when unlocked", () => {
    expect(badgeForStatus("unlocked").text).toBe("");
  });

  it("keeps the brand icon unobscured when locked", () => {
    expect(badgeForStatus("locked").text).toBe("");
  });

  it("keeps the brand icon unobscured when signed-out", () => {
    expect(badgeForStatus("signed-out").text).toBe("");
  });
});

describe("applyBadge", () => {
  function fakeAction(): BadgeApi & {
    setBadgeText: ReturnType<typeof vi.fn>;
  } {
    return {
      setBadgeText: vi.fn(() => Promise.resolve()),
    };
  }

  it("clears a stale badge for a locked session", async () => {
    const action = fakeAction();
    await applyBadge(action, "locked");
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: badgeForStatus("locked").text });
  });

  it("clears the badge text for an unlocked session", async () => {
    const action = fakeAction();
    await applyBadge(action, "unlocked");
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });
});
