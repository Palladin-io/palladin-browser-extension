import { describe, expect, it, vi } from "vitest";
import { IDENTITY_KDF_PROFILE_ID, toBase64Url } from "@palladin/crypto";
import { SharedUnlockApi } from "./api";
import { SharedUnlockSourceAuthority } from "./source-authority";
import type { ManualUnlockContext } from "../session/manual-unlock";
import fixtures from "./fixtures/session-api-v1.json";

const authorization = fixtures.operations[0].sourceAuthorization;
const apiUrl = "https://api.example.test";
const makeContext = (): ManualUnlockContext => ({
  tokens: { accessToken: "own-access", refreshToken: "own-refresh", userId: authorization.accountId, apiUrl },
  account: { userId: authorization.accountId, email: "synthetic@example.test", kdf: {
    securityVersion: 1, minimumSecurityVersion: 1, profileId: IDENTITY_KDF_PROFILE_ID,
    kdfSalt: toBase64Url(new Uint8Array(16)), credentialRevision: authorization.credentialRevision,
    privateKeyWrapRevision: authorization.privateKeyWrapRevision, deviceWrapperMetadata: null,
  } },
  authCredential: new Uint8Array(32).fill(17), limits: authorization, assertCurrent: () => {},
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

for (const enabled of [false, true]) {
  it(`prepares an own manual root while preference is ${enabled} without changing it`, async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: enabled, revision: 3 }))
      .mockResolvedValueOnce(response(authorization));
    const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1);
    const context = makeContext();
    const prepared = await source.prepare(context);
    expect(prepared).toEqual(authorization);
    expect(source.snapshot().preference).toEqual({ sharedUnlockEnabled: enabled, revision: 3 });
    expect(source.snapshot().sourceGeneration).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(body).toMatchObject({ refreshToken: "own-refresh", authCredential: toBase64Url(new Uint8Array(32).fill(17)),
      expectedPreferenceRevision: 3, idleDeadlineMs: authorization.idleDeadlineMs,
      absoluteDeadlineMs: authorization.absoluteDeadlineMs, offlineDeadlineMs: authorization.offlineDeadlineMs });
    expect(context.authCredential).toEqual(new Uint8Array(32));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, request]) => request?.method)).toEqual(["GET", "POST"]);
  });
}

describe("manual authority cancellation", () => {
  for (const status of [401, 403, 409, 429, 503]) {
    it(`clears failed sharing at ${status} without retrying or writing the preference`, async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: false, revision: 3 }))
        .mockResolvedValueOnce(response({}, status));
      const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl));
      const context = makeContext();
      expect(await source.prepare(context)).toBeNull();
      expect(source.snapshot()).toMatchObject({ authorization: null, sourceGeneration: null,
        preference: { sharedUnlockEnabled: false, revision: 3 } });
      expect(context.authCredential).toEqual(new Uint8Array(32));
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  }

  it("drops a late successful root after reset, even if fetch ignores abort", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: true, revision: 3 }))
      .mockReturnValueOnce(pending);
    const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl));
    const context = makeContext(); const preparing = source.prepare(context);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    source.reset(); expect(context.authCredential).toEqual(new Uint8Array(32)); release(response(authorization));
    expect(await preparing).toBeNull();
    expect(source.snapshot()).toEqual({ preference: null, authorization: null, sourceGeneration: null, failure: null });
    expect(context.authCredential).toEqual(new Uint8Array(32));
  });

  it("does not retain an expired or locally invalidated root", async () => {
    let now = authorization.unlockedAtMs + 1;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith("authorizations")
      ? response(authorization) : response({ sharedUnlockEnabled: true, revision: 3 }));
    const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => now);
    await source.prepare(makeContext());
    now = authorization.idleDeadlineMs;
    expect(source.snapshot().authorization).toBeNull();
    now = authorization.unlockedAtMs + 1;
    let current = true;
    await source.prepare({ ...makeContext(), assertCurrent: () => { if (!current) throw new Error("locked"); } });
    current = false;
    expect(source.snapshot().authorization).toBeNull();
  });
});
