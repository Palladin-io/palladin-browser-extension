import { afterEach, expect, it, vi } from "vitest";
import { SharedUnlockApi } from "./api";
import { SharedUnlockSourceAuthority } from "./source-authority";
import { SharedUnlockExpiryStore } from "./expiry-store";
import { OwnSharedUnlockActivityRecorder } from "./own-activity";
import fixtures from "./fixtures/session-api-v1.json";

const apiUrl = "https://api.example.test";
const base = fixtures.operations[0].sourceAuthorization;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
async function harness(pause = false) {
  vi.useFakeTimers(); vi.setSystemTime(base.unlockedAtMs);
  const now = Date.now(), root = { ...base, idleDeadlineMs: now + 1_000, absoluteDeadlineMs: now + 10_000, offlineDeadlineMs: now + 8_000 };
  let current = true, release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(apiUrl + '/api/account/shared-unlock/authorizations/activity');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer own-access');
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    expect(body).toMatchObject({ refreshToken: 'own-refresh', authorizationId: root.authorizationId, sourceGeneration: 'A'.repeat(43) });
    expect(Object.keys(body).sort()).toEqual(['authorizationId', 'idleDeadlineMs', 'refreshToken', 'sourceGeneration']);
    return pause && bodies.length === 1 ? pending : new Response(JSON.stringify({ ...root, idleDeadlineMs: body.idleDeadlineMs }));
  });
  const api = new SharedUnlockApi(fetcher, () => apiUrl), authority = new SharedUnlockSourceAuthority(api);
  const check = () => { if (!current) throw new Error('own session changed'); };
  authority.adopt(root, 'A'.repeat(43), { sharedUnlockEnabled: false, revision: 1 }, check);
  const values: Record<string, unknown> = {}, storage = { get: async () => values,
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }) };
  const expiry = new SharedUnlockExpiryStore(storage, action => action());
  const scope = { apiUrl, accountId: root.accountId };
  await expiry.checkpoint(scope, root.sequence, root.idleDeadlineMs, root.offlineDeadlineMs);
  const recorder = new OwnSharedUnlockActivityRecorder(api, expiry);
  const record = (idleDeadlineMs: number) => {
    const controller = new AbortController(), lease = authority.captureActivity();
    const dispose = vi.fn(() => { lease.dispose(); controller.abort(); });
    cleanups.push(() => { controller.abort(); lease.dispose(); });
    recorder.record({ session: { apiUrl, userId: root.accountId, accessToken: 'own-access', refreshToken: 'own-refresh' },
      authority: lease, idleDeadlineMs, signal: controller.signal,
      assertCurrent: () => { check(); if (Date.now() >= Math.min(idleDeadlineMs, root.offlineDeadlineMs)) throw new Error('own keys expired'); }, dispose });
    return { controller, dispose };
  };
  cleanups.push(() => { current = false; authority.reset(); });
  return { now, root, authority, expiry, scope, storage, record, fetcher, bodies, release, invalidate: () => { current = false; } };
}
it('renews only own Identity/idle while OFF, preserving original hard ceilings and sequence', async () => {
  const h = await harness(); const run = h.record(h.now + 4_000);
  await vi.waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
  expect(h.authority.snapshot().authorization).toEqual({ ...h.root, idleDeadlineMs: h.now + 4_000 });
  expect(h.authority.snapshot().preference?.sharedUnlockEnabled).toBe(false);
  expect(await h.expiry.checkpoint(h.scope, h.root.sequence, h.now + 7_000, h.root.offlineDeadlineMs)).toBe(h.now + 4_000);
  expect(h.fetcher).toHaveBeenCalledOnce();
});
it('hides the old expired source while a still-live own renewal awaits its Identity reply', async () => {
  const h = await harness(true), run = h.record(h.now + 4_000);
  await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  vi.setSystemTime(h.now + 1_500);
  expect(h.authority.snapshot().authorization).toBeNull();
  h.release(new Response(JSON.stringify({ ...h.root, idleDeadlineMs: h.now + 4_000 })));
  await vi.waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
  expect(h.authority.snapshot().authorization?.idleDeadlineMs).toBe(h.now + 4_000);
});
it('coalesces pending input and sends its original deadline instead of adding queue time', async () => {
  const h = await harness(true), first = h.record(h.now + 3_000);
  await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const second = h.record(h.now + 4_000), latest = h.record(h.now + 5_000);
  expect(second.dispose).toHaveBeenCalledOnce();
  h.release(new Response(JSON.stringify({ ...h.root, idleDeadlineMs: h.now + 3_000 })));
  await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(latest.dispose).toHaveBeenCalledOnce());
  expect(h.bodies.map(body => body.idleDeadlineMs)).toEqual([h.now + 3_000, h.now + 5_000]);
});
it('cannot publish an old response into a newer own root', async () => {
  const h = await harness(true), run = h.record(h.now + 4_000);
  await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const newer = { ...h.root, authorizationId: '99999999-9999-4999-8999-999999999999', sequence: h.root.sequence + 1 };
  h.authority.adopt(newer, 'B'.repeat(43), { sharedUnlockEnabled: true, revision: 2 }, () => {});
  h.release(new Response(JSON.stringify({ ...h.root, idleDeadlineMs: h.now + 4_000 })));
  await vi.waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
  expect(h.authority.snapshot().authorization).toEqual(newer);
});
it('cleans up on a lost own session even if fetch ignores cancellation', async () => {
  const h = await harness(true), run = h.record(h.now + 4_000);
  await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  h.invalidate(); run.controller.abort();
  await vi.waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
  h.release(new Response(JSON.stringify({ ...h.root, idleDeadlineMs: h.now + 4_000 })));
  await Promise.resolve();
  expect(h.authority.snapshot().authorization).toBeNull();
});
it('does not request Identity renewal after a checkpoint write failure', async () => {
  const h = await harness(); h.storage.set.mockRejectedValueOnce(new Error('disk unavailable'));
  const run = h.record(h.now + 4_000);
  await vi.waitFor(() => expect(run.dispose).toHaveBeenCalledOnce());
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(h.authority.snapshot().authorization).toEqual(h.root);
});
it('bounds an ignored fetch abort to two seconds without replay', async () => {
  const h = await harness(true), run = h.record(h.now + 4_000);
  await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(2_000);
  expect(run.dispose).toHaveBeenCalledOnce(); expect(h.fetcher).toHaveBeenCalledOnce();
  expect(h.authority.snapshot().authorization).toBeNull();
});
