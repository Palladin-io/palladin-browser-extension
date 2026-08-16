import { describe, expect, it, vi } from "vitest";

import {
  handleServerConfigRuntimeMessage,
  isServerConfigCommand,
  type ServerConfigCommandDeps,
} from "./server-commands";

function deps(): ServerConfigCommandDeps {
  return {
    getApiUrl: vi.fn(() => "https://api.palladin.io"),
    hasAccess: vi.fn(async () => true),
    beforeChange: vi.fn(async () => undefined),
    save: vi.fn(async (apiUrl) => apiUrl),
  };
}

describe("server configuration commands", () => {
  it("accepts only the exact typed command shape", () => {
    expect(isServerConfigCommand({ type: "config/server/get" })).toBe(true);
    expect(isServerConfigCommand({ type: "config/server/get", extra: true })).toBe(false);
    expect(isServerConfigCommand({ type: "config/server/set", apiUrl: "https://example.com" }))
      .toBe(true);
    expect(isServerConfigCommand({ type: "config/server/set", apiUrl: 7 })).toBe(false);
  });

  it("returns the active URL without mutating session state", async () => {
    const commandDeps = deps();
    await expect(handleServerConfigRuntimeMessage(commandDeps, { type: "config/server/get" }))
      .resolves.toEqual({
        ok: true,
        apiUrl: "https://api.palladin.io",
        changed: false,
      });
    expect(commandDeps.beforeChange).not.toHaveBeenCalled();
  });

  it("rejects unsafe URLs before any lifecycle effect", async () => {
    const commandDeps = deps();
    await expect(handleServerConfigRuntimeMessage(commandDeps, {
      type: "config/server/set",
      apiUrl: "http://attacker.example.com",
    })).resolves.toEqual({ ok: false, code: "invalid-server" });
    expect(commandDeps.beforeChange).not.toHaveBeenCalled();
    expect(commandDeps.save).not.toHaveBeenCalled();
    expect(commandDeps.hasAccess).not.toHaveBeenCalled();
  });

  it("rejects an ungranted origin before signing out", async () => {
    const commandDeps = deps();
    vi.mocked(commandDeps.hasAccess).mockResolvedValue(false);
    await expect(handleServerConfigRuntimeMessage(commandDeps, {
      type: "config/server/set",
      apiUrl: "https://vault.example.com",
    })).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(commandDeps.beforeChange).not.toHaveBeenCalled();
    expect(commandDeps.save).not.toHaveBeenCalled();
  });

  it("signs out and clears local state before committing a changed server", async () => {
    const order: string[] = [];
    const commandDeps = deps();
    vi.mocked(commandDeps.beforeChange).mockImplementation(async () => { order.push("wipe"); });
    vi.mocked(commandDeps.save).mockImplementation(async (apiUrl) => {
      order.push("save");
      return apiUrl;
    });

    await expect(handleServerConfigRuntimeMessage(commandDeps, {
      type: "config/server/set",
      apiUrl: " https://vault.example.com/ ",
    })).resolves.toEqual({
      ok: true,
      apiUrl: "https://vault.example.com",
      changed: true,
    });
    expect(order).toEqual(["wipe", "save"]);
  });

  it("does not sign out when the normalized URL is unchanged", async () => {
    const commandDeps = deps();
    await expect(handleServerConfigRuntimeMessage(commandDeps, {
      type: "config/server/set",
      apiUrl: "https://api.palladin.io/",
    })).resolves.toEqual({
      ok: true,
      apiUrl: "https://api.palladin.io",
      changed: false,
    });
    expect(commandDeps.beforeChange).not.toHaveBeenCalled();
  });
});
