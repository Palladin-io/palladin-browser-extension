import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import wire from '../../../tests/fixtures/protocol/deferred-live-v2.json';
import passwordWire from '../../../tests/fixtures/protocol/deferred-password-v2.json';
import { handleNativeAgentMessage, type AgentFillDeps, type AgentProviderSession } from './native-provider';
import { cancelPendingDeferred } from './native-deferred';
import type { AgentInjectForm } from '@shared/messaging';
let elapsed = 0;
beforeEach(() => { elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed); });
afterEach(() => vi.restoreAllMocks());
const url = 'https://login.example.test/', documentId = 'd'.repeat(32);
function fixture() {
  const form = structuredClone(wire.inject.form) as AgentInjectForm;
  const page = { id: 7, page: { url, documentId } };
  const ready = { ...wire.submitReady.submitReady };
  const deps = {
    getActivePage: vi.fn(async () => page), getPageById: vi.fn(async () => page), inspectLiveLogin: vi.fn(async () => form),
    probeLiveLogin: vi.fn<NonNullable<AgentFillDeps['probeLiveLogin']>>(async () => ({ outcome: 'no-form' } as const)), wait: vi.fn(async (ms: number) => { elapsed += ms; }),
    sendStep: vi.fn(async () => ({ ok: true } as const)), probeTransition: vi.fn(async () => ({ status: 'ready' } as const)),
    fillDeferred: vi.fn(async (_tab: number, message: { pendingId: string }) => ({ ok: true as const, submitReady: { ...ready, pendingId: message.pendingId, submitSelector: `palladin-live:${message.pendingId}:${'3'.repeat(32)}` } })),
    commitDeferred: vi.fn(async () => ({ ok: true } as const)), cancelDeferred: vi.fn(async () => {}),
  } satisfies AgentFillDeps;
  const session: AgentProviderSession = { prepared: null }, replay = { consume: vi.fn(async () => true) };
  const send = (message: unknown) => handleNativeAgentMessage(deps, replay, session, message);
  const prepare = () => send({ protocol: 'palladin.inject-provider.v1', type: 'prepare', nonce: 'a'.repeat(64), targetTabId: 7, targetUrl: url, liveDetection: true });
  const inject = () => send({ ...structuredClone(wire.inject), expiresAt: Date.now() + 20_000 });
  const commit = (overrides = {}) => send({ ...wire.submit, submitReady: session.pendingSubmit!.ready, expiresAt: Date.now() + 5_000, ...overrides });
  return { deps, session, replay, send, prepare, inject, commit };
}
it('requires a distinct commit after fill, counts one stage only after physical submit and never replays fill', async () => {
  const f = fixture(); await f.prepare();
  expect(await f.inject()).toMatchObject({ outcome: 'submit-ready' });
  expect(f.session.pendingSubmit!.chain.steps).toBe(0);
  expect(f.deps.commitDeferred).not.toHaveBeenCalled(); expect(f.deps.sendStep).not.toHaveBeenCalled();
  const commit = { ...wire.submit, submitReady: f.session.pendingSubmit!.ready, expiresAt: Date.now() + 5_000 };
  expect(await f.send(commit)).toMatchObject({ outcome: 'injected', continuation: { outcome: 'no-form' } });
  expect(await f.send(commit)).toMatchObject({ outcome: 'rejected' });
  expect(f.deps.fillDeferred).toHaveBeenCalledTimes(1); expect(f.deps.commitDeferred).toHaveBeenCalledTimes(1);
});
it('continues one deferred username into one fresh deferred password with the same chain and carried identity', async () => {
  const f = fixture(); await f.prepare(); await f.inject();
  const passwordForm = structuredClone(passwordWire.carriedUsername.inject.form) as AgentInjectForm;
  f.deps.probeLiveLogin.mockResolvedValue({ outcome: 'ready', form: passwordForm });
  expect(await f.commit()).toMatchObject({ outcome: 'injected', continuation: { outcome: 'ready', liveForm: passwordForm } });
  const chain = f.session.liveChain!; expect(chain.steps).toBe(1);
  const next = { ...structuredClone(passwordWire.carriedUsername.inject), transactionId: 'password-tx', expiresAt: Date.now() + 10_000 };
  expect(await f.send(next)).toMatchObject({ outcome: 'submit-ready' });
  expect(f.session.pendingSubmit!.chain).toBe(chain); expect(chain.steps).toBe(1);
  expect(f.deps.fillDeferred).toHaveBeenLastCalledWith(7, expect.objectContaining({ requireExistingUsername: true }));
  const commit = { ...wire.submit, transactionId: 'password-commit', preparedTransactionId: 'password-tx', submitReady: f.session.pendingSubmit!.ready, expiresAt: Date.now() + 1000 };
  // An unchanged password step after submission times out instead of replaying.
  expect(await f.send(commit)).toMatchObject({ outcome: 'injected', continuation: { outcome: 'timeout' } });
  expect(chain.steps).toBe(2); expect(f.deps.fillDeferred).toHaveBeenCalledTimes(2); expect(f.deps.commitDeferred).toHaveBeenCalledTimes(2);
  expect(await f.send(commit)).toMatchObject({ outcome: 'rejected' });
});
it.each(['grantId','entryId','expectedDomain','preparedTransactionId','expired','replay','document','lost-response'])('fails closed on %s before/after the one commit', async mutation => {
  const f = fixture(); await f.prepare(); await f.inject();
  const overrides: Record<string, unknown> = {};
  if (['grantId','entryId','preparedTransactionId'].includes(mutation)) overrides[mutation] = 'other';
  if (mutation === 'expectedDomain') overrides.expectedDomain = 'other.example.test';
  if (mutation === 'expired') overrides.expiresAt = Date.now() - 1;
  if (mutation === 'replay') f.replay.consume.mockResolvedValue(false);
  if (mutation === 'document') f.deps.getPageById.mockResolvedValue({ id: 7, page: { url, documentId: 'e'.repeat(32) } });
  if (mutation === 'lost-response') f.deps.commitDeferred.mockResolvedValue(null as never);
  const response = await f.commit(overrides); expect(response.outcome).not.toBe('injected');
  expect(f.deps.commitDeferred).toHaveBeenCalledTimes(mutation === 'lost-response' ? 1 : 0);
  expect(f.deps.cancelDeferred).toHaveBeenCalled(); expect(f.session.pendingSubmit).toBeNull();
  expect(f.deps.fillDeferred).toHaveBeenCalledTimes(1);
});
it('cancels pending preparation on disconnect and ignores a late ready response', async () => {
  const f = fixture(); await f.prepare();
  let release!: () => void;
  f.deps.fillDeferred.mockImplementation(async (_tab, message) => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, submitReady: { ...wire.submitReady.submitReady, pendingId: message.pendingId, submitSelector: `palladin-live:${message.pendingId}:${'3'.repeat(32)}` } }; });
  const response = f.inject(); await vi.waitFor(() => expect(f.session.pendingSubmit).toBeTruthy());
  cancelPendingDeferred(f.deps, f.session); release();
  expect((await response).outcome).not.toBe('submit-ready'); expect(f.deps.cancelDeferred).toHaveBeenCalledTimes(1);
  expect(f.deps.commitDeferred).not.toHaveBeenCalled();
});
it('accepts cancellation only for the current connection-owned tuple', async () => {
  const f = fixture(); await f.prepare(); await f.inject();
  const pendingId = f.session.pendingSubmit!.pendingId;
  await f.send({ ...wire.cancel, pendingId: 'f'.repeat(32) }); expect(f.session.pendingSubmit).not.toBeNull();
  await f.send({ ...wire.cancel, pendingId }); expect(f.session.pendingSubmit).toBeNull(); expect(f.deps.cancelDeferred).toHaveBeenCalledTimes(1);
});
