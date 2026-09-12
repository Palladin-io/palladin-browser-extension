import { describe, expect, it } from "vitest";
import { validateSharedUnlockRouting } from "./validate-built-manifest.mjs";
const environments = [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test:8443" }];
const manifest = { permissions: ["webNavigation"], externally_connectable: {
  ids: [], matches: ["https://app.example.test/*"], accepts_tls_channel_id: false,
} };
describe("built shared unlock routing gate", () => {
  const safari = { permissions: ["webNavigation"], externally_connectable: { matches: ["https://app.example.test/*"] } };
  it("accepts the independently configured Safari route without Chromium identity fields", () => {
    expect(() => validateSharedUnlockRouting(safari, "safari", environments)).not.toThrow();
    expect(() => validateSharedUnlockRouting(safari, "safari")).toThrow();
    expect(() => validateSharedUnlockRouting(safari, "chromium", environments)).toThrow();
  });
  it.each([{ ids: ["*"] }, { matches: ["https://*/*"] }, { matches: ["https://other.test/*"] },
    { accepts_tls_channel_id: false }, { unexpected: true },
  ])("rejects widened or substituted Safari routing %#", patch => {
    expect(() => validateSharedUnlockRouting({ ...safari, externally_connectable: { ...safari.externally_connectable, ...patch } }, "safari", environments)).toThrow();
  });
  it("rejects Safari without navigation authority or with an exposed manifest", () => {
    expect(() => validateSharedUnlockRouting({ ...safari, permissions: [] }, "safari", environments)).toThrow();
    expect(() => validateSharedUnlockRouting({ ...safari, web_accessible_resources: [{ resources: ["manifest.json"], matches: ["<all_urls>"] }] }, "safari", environments)).toThrow();
  });
  const firefox = { permissions: ["webNavigation"], web_accessible_resources: [{
    resources: ["manifest.json", "src/shared-unlock-bridge/index.html"], matches: ["https://app.example.test/*"],
  }] };
  it("accepts only the explicitly configured Firefox bridge and canonical manifest", () => {
    expect(() => validateSharedUnlockRouting(firefox, "firefox", environments)).not.toThrow();
    expect(() => validateSharedUnlockRouting(firefox, "firefox")).toThrow();
    expect(() => validateSharedUnlockRouting(firefox, "chromium", environments)).toThrow();
  });
  it.each([
    { resources: ["*"] }, { resources: ["manifest.json", "src/*"] }, { matches: ["<all_urls>"] },
    { matches: ["https://other.example.test/*"] }, { extension_ids: ["*"] },
  ])("rejects widened Firefox resource routing %#", patch => {
    expect(() => validateSharedUnlockRouting({ ...firefox, web_accessible_resources: [{ ...firefox.web_accessible_resources[0], ...patch }] }, "firefox", environments)).toThrow();
  });
  it("rejects a second public route to the canonical manifest", () => {
    expect(() => validateSharedUnlockRouting({ ...firefox, web_accessible_resources: [
      ...firefox.web_accessible_resources, { resources: ["manifest.*"], matches: ["<all_urls>"] },
    ] }, "firefox", environments)).toThrow();
  });
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
