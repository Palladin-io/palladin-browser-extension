import { describe, expect, it } from "vitest";

import {
  nativeHostNameForChannel,
  resolveExtensionBuildChannel,
} from "./build-channel";

describe("extension build channel", () => {
  it("defaults packaged builds to production", () => {
    expect(resolveExtensionBuildChannel(undefined)).toBe("production");
  });

  it("keeps production and debug native hosts separate", () => {
    expect(nativeHostNameForChannel("production")).toBe("io.palladin");
    expect(nativeHostNameForChannel("debug")).toBe("io.palladin.debug");
  });

  it("rejects an unknown channel", () => {
    expect(() => resolveExtensionBuildChannel("staging")).toThrow(
      /Unknown extension build channel/,
    );
  });
});
