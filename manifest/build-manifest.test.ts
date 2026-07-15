import { describe, expect, it } from "vitest";

import { buildManifest } from "./build-manifest";

// The plugin consumes a loose manifest shape; this test reads it as a bag of
// known fields so we can assert MV3 correctness and least-privilege without
// fighting the export's union type.
type Manifest = {
  manifest_version: number;
  name: string;
  background?: { service_worker?: string; type?: string };
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: Array<{ matches: string[]; js: string[]; world?: string }>;
  minimum_chrome_version?: string;
};

const manifest = buildManifest("chromium") as unknown as Manifest;

describe("buildManifest (chromium)", () => {
  it("is a valid MV3 manifest with a module service worker", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("Palladin");
    expect(manifest.background?.service_worker).toBeTruthy();
    expect(manifest.background?.type).toBe("module");
  });

  it("requests only the least-privilege start permissions", () => {
    expect(new Set(manifest.permissions)).toEqual(
      new Set(["storage", "activeTab", "alarms"]),
    );
    // No broad host_permissions on day zero — access comes via activeTab +
    // content_scripts, pending the CVT-382 least-privilege review.
    expect(manifest.host_permissions ?? []).toEqual([]);
  });

  it("declares both bridge worlds: an isolated script and a MAIN-world slot", () => {
    const worlds = (manifest.content_scripts ?? []).map((cs) => cs.world ?? "ISOLATED");
    expect(worlds).toContain("MAIN");
    expect(worlds).toContain("ISOLATED");
  });

  it("applies the chromium overlay", () => {
    expect(manifest.minimum_chrome_version).toBe("116");
  });

  it("does not merge overlays destructively (base fields survive)", () => {
    // The overlay only adds minimum_chrome_version; base permissions must remain.
    expect(manifest.permissions).toContain("storage");
  });

  it("rejects an unknown build target", () => {
    // @ts-expect-error - exercising the runtime guard with an invalid target
    expect(() => buildManifest("firefox")).toThrow(/Unknown build target/);
  });
});
