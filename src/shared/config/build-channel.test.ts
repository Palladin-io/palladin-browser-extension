import { describe, expect, it } from "vitest";

import { resolveExtensionBuildChannel } from "./build-channel";

describe("extension build channel", () => {
  it("defaults packaged builds to production", () => {
    expect(resolveExtensionBuildChannel(undefined)).toBe("production");
  });

  it("rejects an unknown channel", () => {
    expect(() => resolveExtensionBuildChannel("staging")).toThrow(
      /Unknown extension build channel/,
    );
  });
});
