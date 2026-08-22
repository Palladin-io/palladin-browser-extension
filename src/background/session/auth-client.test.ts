import { describe, expect, it, vi } from "vitest";

import { AuthClient } from "./auth-client";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AuthClient refresh contract", () => {
  it("accepts the backend token-only response without duplicate account identity", async () => {
    const doFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    }));
    const client = new AuthClient(doFetch, "https://api.test");

    await expect(client.refresh("current-refresh")).resolves.toEqual({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
    expect(JSON.parse(String(doFetch.mock.calls[0]?.[1]?.body))).toEqual({
      refreshToken: "current-refresh",
    });
  });

  it("fails closed when a successful refresh omits either replacement token", async () => {
    const client = new AuthClient(
      vi.fn(async () => json({ accessToken: "rotated-access" })),
      "https://api.test",
    );

    await expect(client.refresh("current-refresh")).rejects.toMatchObject({
      name: "SessionError",
      code: "network",
    });
  });
});

describe("AuthClient login rate limiting", () => {
  it.each([
    ["KDF bootstrap", (client: AuthClient) => client.fetchLoginKdf("member@example.com", "profile")],
    ["password login", (client: AuthClient) => client.login({
      email: "member@example.com",
      securityVersion: 1,
      kdfProfileId: "profile",
      authCredential: "credential",
    })],
    ["TOTP login", (client: AuthClient) => client.totpLogin("challenge", "123456")],
  ])("maps 429 with Retry-After for %s", async (_name, operation) => {
    const client = new AuthClient(
      vi.fn(async () => new Response(null, {
        status: 429,
        headers: { "retry-after": "45" },
      })),
      "https://api.test",
    );

    await expect(operation(client)).rejects.toMatchObject({
      name: "SessionError",
      code: "rate-limited",
      retryAfterSeconds: 45,
    });
  });
});
