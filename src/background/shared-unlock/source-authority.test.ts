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
    const remembered = vi.fn()
      const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1, undefined, remembered);
    const context = makeContext();
    const prepared = await source.prepare(context);
    expect(prepared).toEqual(authorization);
      expect(remembered).toHaveBeenCalledExactlyOnceWith(authorization, context.tokens)
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

  it("does not expose an expired or locally invalidated sharing root", async () => {
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

it("accepts a fresh own preference without changing root, generation or deadlines", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: false, revision: 3 }))
    .mockResolvedValueOnce(response(authorization));
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1);
  await source.prepare(makeContext());
  const before = source.snapshot();
  source.acceptPreference({ sharedUnlockEnabled: true, revision: 4 }, before.sourceGeneration!);
  expect(source.snapshot()).toEqual({ ...before, preference: { sharedUnlockEnabled: true, revision: 4 } });
  source.acceptPreference({ sharedUnlockEnabled: false, revision: 5 }, before.sourceGeneration!);
  source.acceptPreference({ sharedUnlockEnabled: true, revision: 4 }, before.sourceGeneration!);
  expect(source.snapshot()).toEqual({ ...before, preference: { sharedUnlockEnabled: false, revision: 5 } });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("cannot manufacture or replace own source authority by accepting a preference", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: true, revision: 3 }))
    .mockResolvedValueOnce(response(authorization));
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1);
  expect(() => source.acceptPreference({ sharedUnlockEnabled: true, revision: 3 }, "other")).toThrow();
  await source.prepare(makeContext());
  const before = source.snapshot();
  expect(() => source.acceptPreference({ sharedUnlockEnabled: false, revision: 4 }, "other")).toThrow();
  expect(source.snapshot()).toEqual(before);
  source.reset();
  expect(() => source.acceptPreference({ sharedUnlockEnabled: true, revision: 5 }, before.sourceGeneration!)).toThrow();
});


it("adopts only a still-current own verified receiver root without requesting a manual proof", () => {
  const fetcher = vi.fn<typeof fetch>(); let current = true;
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1);
  const changed = vi.fn(); const unsubscribe = source.subscribe(changed);
  source.adopt(authorization, "A".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => { if (!current) throw new Error("own session retired"); });
  expect(source.snapshot().authorization).toEqual(authorization);
  expect(source.snapshot().sourceGeneration).toBe("A".repeat(43));
  expect(changed).toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  current = false;
  expect(source.snapshot().authorization).toBeNull();
  expect(() => source.adopt(authorization, "E".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => { throw new Error("new own session"); })).toThrow();
  expect(source.snapshot().authorization).toBeNull(); unsubscribe();
});


it("does not overwrite a newer explicit OFF while adopting a completed own receiver root", () => {
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(vi.fn<typeof fetch>(), () => apiUrl), () => authorization.unlockedAtMs + 1);
  source.adopt(authorization, "A".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => {});
  source.acceptPreference({ sharedUnlockEnabled: false, revision: 2 }, "A".repeat(43));
  source.adopt(authorization, "E".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => {});
  expect(source.snapshot().preference).toEqual({ sharedUnlockEnabled: false, revision: 2 });
});

it('notifies source selection on account ON/OFF without renewing its own root', () => {
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(vi.fn<typeof fetch>(), () => apiUrl), () => authorization.unlockedAtMs + 1)
  const generation = 'A'.repeat(43)
  source.adopt(authorization, generation, { sharedUnlockEnabled: true, revision: 1 }, () => {})
  const changed = vi.fn(), unsubscribe = source.subscribe(changed)
  source.acceptPreference({ sharedUnlockEnabled: false, revision: 2 }, generation)
  expect(changed).toHaveBeenCalledOnce()
  source.acceptPreference({ sharedUnlockEnabled: false, revision: 2 }, generation)
  source.acceptPreference({ sharedUnlockEnabled: true, revision: 1 }, generation)
  expect(changed).toHaveBeenCalledOnce()
  source.acceptPreference({ sharedUnlockEnabled: true, revision: 3 }, generation)
  expect(changed).toHaveBeenCalledTimes(2)
  expect(source.snapshot().authorization).toEqual(authorization)
  expect(source.snapshot().sourceGeneration).toBe(generation)
  unsubscribe()
})


it("settles previous closings before reading fresh preference and authorizing a new root", async () => {
  let finish!: () => void;
  const beforeAuthorize = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: true, revision: 6 }))
    .mockResolvedValueOnce(response({ ...authorization, sequence: authorization.sequence + 2 }));
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1, beforeAuthorize);
  const own = makeContext(); const prepared = source.prepare(own);
  await vi.waitFor(() => expect(beforeAuthorize).toHaveBeenCalledOnce());
  expect(fetcher).not.toHaveBeenCalled();
  finish(); await prepared;
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).expectedPreferenceRevision).toBe(6);
  expect(source.snapshot().authorization?.sequence).toBe(authorization.sequence + 2);
  expect(own.authCredential).toEqual(new Uint8Array(32));
});
it("never sends a fresh proof after closing repair completes for a superseded manual attempt", async () => {
  let finish!: () => void;
  const beforeAuthorize = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const fetcher = vi.fn<typeof fetch>();
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), Date.now, beforeAuthorize);
  const own = makeContext(); const prepared = source.prepare(own);
  await vi.waitFor(() => expect(beforeAuthorize).toHaveBeenCalledOnce());
  source.reset(); finish(); await prepared;
  expect(fetcher).not.toHaveBeenCalled(); expect(own.authCredential).toEqual(new Uint8Array(32));
});


it("does not extend the manual proof deadline while a suspended closing repair resumes", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>();
    const beforeAuthorize = async () => { vi.setSystemTime(Date.now() + 10_001); };
    const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), Date.now, beforeAuthorize);
    const own = makeContext(); await source.prepare(own);
    expect(fetcher).not.toHaveBeenCalled(); expect(own.authCredential).toEqual(new Uint8Array(32));
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('publishes own source authority only after its durable checkpoint and keeps the saved shorter limit', async () => {
  const own = makeContext();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: true, revision: 3 })).mockResolvedValueOnce(response(authorization));
  let release!: (value: number) => void;
  const save = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1, undefined, save);
  const preparation = source.prepare(own);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(source.snapshot().authorization).toBeNull();
  release(authorization.unlockedAtMs + 50);
  await preparation;
  expect(source.snapshot().authorization?.idleDeadlineMs).toBe(authorization.unlockedAtMs + 50);
  expect(own.authCredential).toEqual(new Uint8Array(32));
});
it('disables sharing and wipes the fresh proof when the checkpoint write fails', async () => {
  const own = makeContext();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: true, revision: 3 })).mockResolvedValueOnce(response(authorization));
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1, undefined, async () => { throw new Error('disk unavailable'); });
  await source.prepare(own);
  expect(source.snapshot().authorization).toBeNull();
  expect(own.authCredential).toEqual(new Uint8Array(32));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('cancels a stalled checkpoint at the existing ten-second proof deadline', async () => {
  vi.useFakeTimers();
  try {
    const own = makeContext();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: true, revision: 3 })).mockResolvedValueOnce(response(authorization));
    let release!: (value: number) => void;
    const save = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
    const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), () => authorization.unlockedAtMs + 1, undefined, save);
    const preparation = source.prepare(own);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    await preparation;
    expect(own.authCredential).toEqual(new Uint8Array(32));
    expect(source.snapshot().authorization).toBeNull();
    release(authorization.idleDeadlineMs);
    await Promise.resolve();
    expect(source.snapshot().authorization).toBeNull();
  } finally { vi.useRealTimers(); }
});


it("retains only a closing witness after sharing expires, then clears it with the own generation", () => {
  let now = authorization.unlockedAtMs + 1, current = true;
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(vi.fn<typeof fetch>(), () => apiUrl), () => now);
  const check = () => { if (!current) throw new Error("own session retired"); };
  source.adopt(authorization, "A".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, check);
  const witness = { authorizationId: authorization.authorizationId, sequence: authorization.sequence, sourceGeneration: "A".repeat(43) };
  now = authorization.idleDeadlineMs;
  expect(source.snapshot()).toMatchObject({ authorization: null, sourceGeneration: null });
  expect(source.closingWitness()).toEqual(witness);
  expect(() => source.captureActivity()).toThrow();
  // A clock correction cannot revive discarded sharing authority.
  now = authorization.unlockedAtMs + 1;
  expect(source.snapshot().authorization).toBeNull();
  expect(() => source.captureActivity()).toThrow();
  current = false;
  expect(source.closingWitness()).toBeNull();
  current = true;
  expect(source.closingWitness()).toBeNull();
  source.adopt({ ...authorization, authorizationId: "33333333-3333-4333-8333-333333333333", sequence: authorization.sequence + 1 },
    "B".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, check);
  expect(source.closingWitness()).toMatchObject({ sequence: authorization.sequence + 1, sourceGeneration: "B".repeat(43) });
  source.reset();
  expect(source.closingWitness()).toBeNull();
});


it("rejects in-flight activity after a local restriction and retains closing repair if persistence fails", () => {
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(vi.fn<typeof fetch>(), () => apiUrl), () => authorization.unlockedAtMs + 1);
  source.adopt(authorization, "A".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => {});
  const pending = source.captureActivity(), witness = source.closingWitness();
  const deadline = authorization.unlockedAtMs + 100;
  source.restrictIdleDeadline(deadline);
  expect(() => pending.apply(authorization)).toThrow(); pending.dispose();
  expect(source.snapshot().authorization?.idleDeadlineMs).toBe(deadline);
  source.restrictIdleDeadline(authorization.idleDeadlineMs);
  expect(source.snapshot().authorization?.idleDeadlineMs).toBe(deadline);
  source.suspendSharing();
  expect(source.snapshot().authorization).toBeNull();
  expect(() => source.captureActivity()).toThrow();
  expect(source.closingWitness()).toEqual(witness);
});


it('keeps only the authenticated prior lock checkpoint after 429 and retires it with the own key generation', async () => {
  const prior = { linkId: '22222222-2222-4222-8222-222222222222', lastInvalidationSequence: 3 }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sharedUnlockEnabled: true, revision: 1 }))
    .mockResolvedValueOnce(response({}, 429))
  let current = true
  const own = makeContext()
  own.assertCurrent = () => { if (!current) throw new Error('own generation retired') }
  const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl),
    () => authorization.unlockedAtMs + 1, async () => [prior])
  await source.prepare(own)
  expect(source.manualLockCheckpoints()).toEqual([prior])
  expect(source.manualLockCheckpoints()?.[0]).not.toBe(prior)
  expect(source.closingWitness()).toBeNull()
  expect(source.snapshot()).toMatchObject({ authorization: null, sourceGeneration: null })
  expect(() => source.captureActivity()).toThrow()
  expect(own.authCredential).toEqual(new Uint8Array(32))
  expect(fetcher).toHaveBeenCalledTimes(2)
  current = false
  expect(source.manualLockCheckpoints()).toBeNull()
})

it('does not retain a checkpoint when its authenticated read fails or the own generation changes during the read', async () => {
  for (const reason of ['read-failed', 'generation-changed'] as const) {
    let current = true
    const own = makeContext()
    own.assertCurrent = () => { if (!current) throw new Error('own generation retired') }
    const fetcher = vi.fn<typeof fetch>()
    const source = new SharedUnlockSourceAuthority(new SharedUnlockApi(fetcher, () => apiUrl), Date.now, async () => {
      if (reason === 'read-failed') throw new Error('offline')
      current = false
      return [{ linkId: '22222222-2222-4222-8222-222222222222', lastInvalidationSequence: 3 }]
    })
    await source.prepare(own)
    expect(source.manualLockCheckpoints()).toBeNull()
    expect(source.closingWitness()).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(own.authCredential).toEqual(new Uint8Array(32))
  }
})
