import { describe, expect, it, vi } from "vitest";

import { applyBadge, badgeForStatus, type BadgeApi } from "./badge";

describe("badgeForStatus", () => {
  it("clears the badge when unlocked", () => {
    expect(badgeForStatus("unlocked").text).toBe("");
  });

  it("shows the padlock when locked", () => {
    expect(badgeForStatus("locked").text).not.toBe("");
  });

  it("shows the padlock when signed-out", () => {
    expect(badgeForStatus("signed-out").text).not.toBe("");
  });

  it("uses the same padlock glyph for locked and signed-out", () => {
    expect(badgeForStatus("locked").text).toBe(badgeForStatus("signed-out").text);
  });
});

describe("applyBadge", () => {
  function fakeAction(): BadgeApi & {
    setBadgeText: ReturnType<typeof vi.fn>;
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  } {
    return {
      setBadgeText: vi.fn(() => Promise.resolve()),
      setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
    };
  }

  it("paints the padlock text for a locked session", async () => {
    const action = fakeAction();
    await applyBadge(action, "locked");
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: badgeForStatus("locked").text });
    expect(action.setBadgeBackgroundColor).toHaveBeenCalledOnce();
  });

  it("clears the badge text for an unlocked session", async () => {
    const action = fakeAction();
    await applyBadge(action, "unlocked");
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });
});
