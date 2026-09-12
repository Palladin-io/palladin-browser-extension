import { afterEach, describe, expect, it, vi } from "vitest";

const environments = [{ apiUrl: "http://localhost:55083", webOrigin: "http://127.0.0.1:55189" }];
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("packaged shared-unlock environment authority", () => {
  it.each(["chromium", "firefox", "safari"])("passes explicit environments to the %s runtime", async target => {
    vi.stubEnv("PALLADIN_TARGET", target);
    vi.stubEnv("PALLADIN_CHANNEL", "production");
    vi.stubEnv("VITE_SHARED_UNLOCK_ENVIRONMENTS", JSON.stringify(environments));
    vi.resetModules();
    const { default: createConfig } = await import("../vite.config");
    if (typeof createConfig !== "function") throw new Error("Expected the build config factory");
    const config = await createConfig({ command: "build", mode: "production" });
    expect(config.define?.__PALLADIN_TARGET__).toBe(JSON.stringify(target));
    expect(config.define?.__PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__).toBe(JSON.stringify(environments));
  });
});
