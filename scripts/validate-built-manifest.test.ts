import { describe, expect, it } from "vitest";
import { validateSharedUnlockRouting } from "./validate-built-manifest.mjs";
const environments = [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test:8443" }];
const manifest = { permissions: ["webNavigation"], externally_connectable: {
  ids: [], matches: ["https://app.example.test/*"], accepts_tls_channel_id: false,
} };
describe("built shared unlock routing gate", () => {
  it("checks the generated manifest against independent build configuration", () => {
    expect(() => validateSharedUnlockRouting(manifest, "chromium", environments)).not.toThrow();
  });
  it.each(["chromium", "firefox", "safari"])("rejects unconfigured routes on %s", target => {
    expect(() => validateSharedUnlockRouting(manifest, target)).toThrow();
    expect(() => validateSharedUnlockRouting({ permissions: [] }, target)).not.toThrow();
  });
  it.each(["firefox", "safari"])("does not activate %s through Chromium configuration", target => {
    expect(() => validateSharedUnlockRouting(manifest, target, environments)).toThrow();
  });
  it.each([{ ids: ["*"] }, { matches: ["https://*/*"] }, { matches: ["https://other.example.test/*"] },
    { matches: [...manifest.externally_connectable.matches, "http://app.example.test/*"] },
    { accepts_tls_channel_id: true }, { unexpected: true },
  ])("rejects widened or altered route %#", patch => {
    expect(() => validateSharedUnlockRouting({ ...manifest, externally_connectable: { ...manifest.externally_connectable, ...patch } }, "chromium", environments)).toThrow();
  });
  it("requires navigation authority with the external route", () => {
    expect(() => validateSharedUnlockRouting({ ...manifest, permissions: [] }, "chromium", environments)).toThrow();
  });
});
