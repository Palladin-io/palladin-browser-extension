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

  it("leaves serialized permission cleanup to the background transaction", async () => {
    const permissions = permissionClient();
    const command = vi.fn<SendServerConfigCommand>(async () => ({
      ok: false as const,
      code: "unavailable",
    }));
    const client = createServerConfigClient(command, permissions);

    await expect(client.save("https://vault.example.com")).rejects
      .toEqual(new ServerConfigClientError("unavailable"));
    expect(command).toHaveBeenCalledTimes(1);
  });
});
