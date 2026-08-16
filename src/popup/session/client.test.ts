import { describe, expect, it, vi } from "vitest";

import { createSessionClient, type SendCommand } from "./client";
import { PopupSessionError } from "./errors";

describe("createSessionClient", () => {
  it("unwraps a successful status reply", async () => {
    const send: SendCommand = vi.fn(async () => ({ ok: true, status: "locked" }) as const);
    const client = createSessionClient(send);
    await expect(client.getStatus()).resolves.toBe("locked");
  });

  it("returns the login result (including a TOTP challenge)", async () => {
    const send: SendCommand = vi.fn(
      async () =>
        ({ ok: true, login: { status: "totp-required", challengeToken: "tok" } }) as const,
    );
    const client = createSessionClient(send);
    await expect(client.login("a@b.com", "pw")).resolves.toEqual({
      status: "totp-required",
      challengeToken: "tok",
    });
  });

  it("throws a typed error when the worker replies ok:false", async () => {
    const send: SendCommand = vi.fn(
      async () => ({ ok: false, code: "incorrect-password", message: "nope" }) as const,
    );
    const client = createSessionClient(send);
    await expect(client.unlock("pw")).rejects.toMatchObject({
      name: "PopupSessionError",
      code: "incorrect-password",
    });
  });

  it("treats a missing/garbled reply as a network failure", async () => {
    const send: SendCommand = vi.fn(async () => undefined);
    const client = createSessionClient(send);
    await expect(client.getStatus()).rejects.toBeInstanceOf(PopupSessionError);
    await expect(client.getStatus()).rejects.toMatchObject({ code: "network" });
  });

  it("forwards the exact command shape for login (password untrimmed here)", async () => {
    const send = vi.fn<SendCommand>(async () => ({ ok: true, login: { status: "unlocked" } }) as const);
    const client = createSessionClient(send);
    await client.login("a@b.com", "  spaced  ");
    expect(send).toHaveBeenCalledWith({
      type: "session/login",
      email: "a@b.com",
      password: "  spaced  ",
    });
  });

  it("cancels the background-owned pending TOTP context", async () => {
    const send = vi.fn<SendCommand>(async () => ({ ok: true }) as const);
    const client = createSessionClient(send);

    await client.cancelTotp();

    expect(send).toHaveBeenCalledWith({ type: "session/cancelTotp" });
  });
});
