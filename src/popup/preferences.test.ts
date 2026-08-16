import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, parsePreferences, resolveLocale } from "./preferences";

describe("popup preferences", () => {
  it("defaults malformed persisted values to system preferences", () => {
    expect(parsePreferences({ language: "de", theme: "sepia" })).toEqual(DEFAULT_PREFERENCES);
  });

  it("supports explicit EN/PL and System locale resolution", () => {
    expect(resolveLocale("system", "pl-PL")).toBe("pl");
    expect(resolveLocale("system", "de-DE")).toBe("en");
    expect(resolveLocale("en", "pl-PL")).toBe("en");
  });
});
