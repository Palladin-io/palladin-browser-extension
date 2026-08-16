import { describe, expect, it, vi } from "vitest";

import {
  ServerConfigClientError,
  createServerConfigClient,
  type PermissionClient,
  type SendServerConfigCommand,
} from "./client";

function permissionClient(overrides: Partial<PermissionClient> = {}): PermissionClient {
  return {
    request: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    ...overrides,
  };
}

function send(current = "https://api.palladin.io"): SendServerConfigCommand {
  return vi.fn<SendServerConfigCommand>(async (command) => command.type === "config/server/get"
    ? { ok: true as const, apiUrl: current, changed: false }
    : { ok: true as const, apiUrl: command.apiUrl, changed: command.apiUrl !== current });
}

describe("popup server configuration client", () => {
  it("requests only the exact custom HTTPS origin before saving", async () => {
    const permissions = permissionClient();
    const command = send();
    const client = createServerConfigClient(command, permissions);

    await expect(client.save(" https://vault.example.com/palladin/ ")).resolves.toEqual({
      apiUrl: "https://vault.example.com/palladin",
      changed: true,
    });
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://vault.example.com/*"],
    });
    expect(command).toHaveBeenLastCalledWith({
      type: "config/server/set",
      apiUrl: "https://vault.example.com/palladin",
    });
  });

  it("does not prompt when the install-time production origin is already granted", async () => {
    const permissions = permissionClient();
    const client = createServerConfigClient(send("http://localhost:5000"), permissions);

    await client.save("https://api.palladin.io");
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it("fails before messaging when the URL is insecure", async () => {
    const command = send();
    const client = createServerConfigClient(command, permissionClient());

    await expect(client.save("http://vault.example.com")).rejects
      .toEqual(new ServerConfigClientError("invalid-server"));
    expect(command).not.toHaveBeenCalled();
  });

  it("does not save when the user denies the origin permission", async () => {
    const permissions = permissionClient({ request: vi.fn(async () => false) });
    const command = send();
    const client = createServerConfigClient(command, permissions);

    await expect(client.save("https://vault.example.com")).rejects
      .toEqual(new ServerConfigClientError("permission-denied"));
    expect(command).not.toHaveBeenCalled();
  });

  it("removes a newly granted origin when the worker rejects the change", async () => {
    const permissions = permissionClient();
    const command = vi.fn<SendServerConfigCommand>(async (message) => message.type === "config/server/get"
      ? { ok: true as const, apiUrl: "https://api.palladin.io", changed: false }
      : { ok: false as const, code: "unavailable" });
    const client = createServerConfigClient(command, permissions);

    await expect(client.save("https://vault.example.com")).rejects
      .toEqual(new ServerConfigClientError("unavailable"));
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://vault.example.com/*"],
    });
  });

  it("removes the previous custom origin after a committed change", async () => {
    const permissions = permissionClient();
    const client = createServerConfigClient(send("https://old.example.com"), permissions);

    await client.save("https://new.example.com");
    expect(permissions.remove).toHaveBeenCalledWith({ origins: ["https://old.example.com/*"] });
  });
});
