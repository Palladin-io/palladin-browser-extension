import { describe, expect, it } from "vitest";

import { translate, translationCatalogs } from "./i18n";

describe("popup translations", () => {
  it("keeps English and Polish catalogs in exact key parity", () => {
    expect(Object.keys(translationCatalogs.pl).sort()).toEqual(
      Object.keys(translationCatalogs.en).sort(),
    );
  });

  it("interpolates only named values", () => {
    expect(translate("pl", "capture.description", { site: "example.com" }))
      .toContain("example.com");
  });
});
