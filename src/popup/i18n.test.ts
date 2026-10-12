import { describe, expect, it } from "vitest";

import { translate, translationCatalogs } from "./i18n";

describe("popup translations", () => {
  it("keeps English and Polish catalogs in exact key parity", () => {
    expect(Object.keys(translationCatalogs.pl).sort()).toEqual(
      Object.keys(translationCatalogs.en).sort(),
    );
  });

  it.each(["en", "pl"] as const)("localizes Entry deletion in %s", (locale) => {
    expect(translate(locale, "vault.deleteConfirm", { name: "Example" })).toContain("Example");
    expect(translate(locale, "vault.deleteEntry")).not.toBe("vault.deleteEntry");
  });

  it("interpolates only named values", () => {
    expect(translate("pl", "capture.description", { site: "example.com" }))
      .toContain("example.com");
  });
});
