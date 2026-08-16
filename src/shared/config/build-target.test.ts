import { describe, expect, it } from "vitest";

import { supportsTimedClipboardWipe } from "./build-target";

describe("clipboard support by build target", () => {
  it("enables copy only where the reviewed TTL wipe exists", () => {
    expect(supportsTimedClipboardWipe("chromium")).toBe(true);
    expect(supportsTimedClipboardWipe("firefox")).toBe(false);
    expect(supportsTimedClipboardWipe("safari")).toBe(false);
  });
});
