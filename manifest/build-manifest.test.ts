import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BUILD_TARGETS,
  buildManifest,
  resolveBuildTarget,
  type BuildTarget,
} from "./build-manifest";

// The plugin consumes a loose manifest shape; these tests read the generated
// values as a bag of known fields so platform invariants stay explicit.
interface Manifest {
  manifest_version: number;
  name: string;
  default_locale?: string;
  key?: string;
  background?: {
    service_worker?: string;
    scripts?: string[];
    type?: string;
  };
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_security_policy?: { extension_pages?: string };
  content_scripts?: Array<{ matches: string[]; js: string[]; world?: string }>;
  minimum_chrome_version?: string;
  side_panel?: { default_path?: string };
  sidebar_action?: {
    default_title?: string;
    default_panel?: string;
    default_icon?: Record<string, string>;
  };
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      strict_min_version?: string;
      data_collection_permissions?: { required?: string[] };
    };
    safari?: { strict_min_version?: string };
  };
}

const manifests = Object.fromEntries(
  BUILD_TARGETS.map((target) => [target, buildManifest(target) as unknown as Manifest]),
) as Record<BuildTarget, Manifest>;

describe("buildManifest (shared)", () => {
  it.each(BUILD_TARGETS)("builds a valid %s MV3 manifest", (target) => {
    const manifest = manifests[target];
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.default_locale).toBe("en");
    expect(manifest.background?.service_worker).toBeTruthy();
    expect(manifest.background?.type).toBe("module");
    expect(manifest.host_permissions).toEqual([
      "http://localhost:5000/*",
      "https://api.stage.palladin.io/*",
      "https://api.palladin.io/*",
    ]);
    expect(manifest.optional_host_permissions).toEqual([
      "http://localhost/*",
      "http://127.0.0.1/*",
      "https://*/*",
    ]);
    expect(manifest.content_security_policy?.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; img-src 'self' data: https://assets.palladin.io http://localhost:4566",
    );
    expect(manifest.content_security_policy?.extension_pages).not.toMatch(
      /(?:^|\s)'unsafe-eval'(?:\s|;|$)/,
    );

    const worlds = (manifest.content_scripts ?? []).map(
      (contentScript) => contentScript.world ?? "ISOLATED",
    );
    expect(worlds).toContain("MAIN");
    expect(worlds).toContain("ISOLATED");
  });

  it("resolves only the declared build targets", () => {
    expect(resolveBuildTarget(undefined)).toBe("chromium");
    expect(BUILD_TARGETS).toEqual(["chromium", "firefox", "safari"]);
    expect(resolveBuildTarget("firefox")).toBe("firefox");
    expect(resolveBuildTarget("safari")).toBe("safari");
    expect(() => resolveBuildTarget("opera")).toThrow(/Unknown build target/);
  });

  it("rejects an unknown build target at the manifest boundary", () => {
    // @ts-expect-error - exercising the runtime guard with an invalid target
    expect(() => buildManifest("webkit")).toThrow(/Unknown build target/);
  });
});

describe("buildManifest (chromium)", () => {
  const manifest = manifests.chromium;

  it("keeps one Chromium-family identity and compatibility floor", () => {
    expect(manifest.key).toBeTruthy();
    const digest = createHash("sha256")
      .update(Buffer.from(manifest.key ?? "", "base64"))
      .digest()
      .subarray(0, 16);
    const extensionId = [...digest]
      .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
      .join("");
    // The native-host allowlist and signed session transcript depend on this ID.
    expect(extensionId).toBe("hmljnknogdeonphikmeofcbkikmpokba");
    expect(manifest.minimum_chrome_version).toBe("116");
    expect(manifest.browser_specific_settings).toBeUndefined();
  });

  it("requests the Chromium-only offscreen permission", () => {
    // The service worker has no clipboard, so Chromium's timed wipe runs in a
    // short-lived offscreen document. It grants no host or data access.
    expect(new Set(manifest.permissions)).toEqual(
      new Set([
        "storage",
        "activeTab",
        "alarms",
        "offscreen",
        "nativeMessaging",
        "scripting",
        "sidePanel",
      ]),
    );
  });

  it("does not request installed-extension discovery access", () => {
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it("declares the browser-owned side panel without replacing the quick popup", () => {
    expect(manifest.side_panel).toEqual({ default_path: "src/side-panel/index.html" });
    expect(manifest.sidebar_action).toBeUndefined();
  });
});

describe("buildManifest (firefox)", () => {
  const manifest = manifests.firefox;

  it("declares the Firefox background fallback, stable ID, and version floor", () => {
    expect(manifest.key).toBeUndefined();
    expect(manifest.background?.scripts).toEqual(["src/background/index.ts"]);
    expect(manifest.browser_specific_settings?.gecko).toMatchObject({
      id: "browser-extension@palladin.io",
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: ["authenticationInfo", "browsingActivity"],
      },
    });
  });

  it("does not request Chromium-only offscreen or native messaging permissions", () => {
    expect(new Set(manifest.permissions)).toEqual(
      new Set(["storage", "activeTab", "alarms", "scripting"]),
    );
  });

  it("does not request installed-extension discovery access", () => {
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it("declares Firefox's native sidebar over the shared panel entrypoint", () => {
    expect(manifest.side_panel).toBeUndefined();
    expect(manifest.sidebar_action).toMatchObject({
      default_title: "__MSG_extensionActionTitle__",
      default_panel: "src/side-panel/index.html",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png",
      },
    });
  });
});

describe("buildManifest (safari)", () => {
  const manifest = manifests.safari;

  it("declares the Safari compatibility floor without a Chromium identity", () => {
    expect(manifest.key).toBeUndefined();
    expect(manifest.browser_specific_settings?.safari?.strict_min_version).toBe("16.4");
  });

  it("keeps the popup because Safari has no equivalent side-panel adapter", () => {
    expect(manifest.side_panel).toBeUndefined();
    expect(manifest.sidebar_action).toBeUndefined();
  });

  it("does not request Chromium-only offscreen or native messaging permissions", () => {
    expect(new Set(manifest.permissions)).toEqual(
      new Set(["storage", "activeTab", "alarms", "scripting"]),
    );
  });

  it("does not expose installed-extension discovery on Safari", () => {
    expect(manifest.optional_permissions).toBeUndefined();
  });
});
