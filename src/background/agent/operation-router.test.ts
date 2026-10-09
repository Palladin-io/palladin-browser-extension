import { afterEach, expect, it, vi } from 'vitest';
import { AGENT_INJECT_PROTOCOL, type AgentInjectForm } from '@shared/messaging';
import fixture from '../../../tests/fixtures/protocol/deferred-live-v2.json';
import { NativeOperationRouter } from './operation-router';
import type { AgentFillDeps } from './native-provider';

const first = 'a'.repeat(32), second = 'b'.repeat(32), third = 'c'.repeat(32);
const url = 'https://login.example.test/';
const documentId = 'd'.repeat(32);
const routers: NativeOperationRouter[] = [];
afterEach(() => { for (const router of routers.splice(0)) router.dispose(); vi.useRealTimers(); });
function setup(overrides: Partial<AgentFillDeps> = {}) {
  const deps: AgentFillDeps = {
    getActivePage: vi.fn(async () => null),
    getPageById: vi.fn(async id => ({ id, page: { url, documentId } })),
    sendStep: vi.fn(async () => ({ ok: true } as const)),
    probeTransition: vi.fn(async () => ({ status: 'ready' } as const)),
    ...overrides,
  };
  const router = new NativeOperationRouter(deps, { consume: async () => true });
  routers.push(router);
  return { router, deps };
}
function request(operationId: string, body: unknown) {
  return { protocol: AGENT_INJECT_PROTOCOL, type: 'operation.request', operationId, request: body };
}
function prepare(operationId: string, targetTabId = 7, liveDetection = false) {
  return request(operationId, { protocol: AGENT_INJECT_PROTOCOL, type: 'prepare', nonce: operationId.repeat(2),
    targetTabId, targetUrl: url, ...(liveDetection ? { liveDetection: true } : {}) });
}
function inject(transactionId: string) {
  return { protocol: AGENT_INJECT_PROTOCOL, type: 'inject', transactionId, grantId: 'grant', entryId: 'entry',
    expectedDomain: 'login.example.test',
    form: { version: 1, steps: [{ fields: [{ entryFieldId: 'credential.password', selector: '#password', control: 'password' }],
      submit: { action: 'click', selector: '#submit' } }] },
    values: [{ entryFieldId: 'credential.password', value: 'synthetic-password' }] };
}

it('reserves a tab before asynchronous preparation and leaves another tab usable', async () => {
  let release!: () => void;
  const { router, deps } = setup({ getPageById: vi.fn(async id => {
    if (id === 7) await new Promise<void>(resolve => { release = resolve; });
    return { id, page: { url, documentId } };
  }) });
  const waiting = router.dispatch(prepare(first));
  expect(await router.dispatch(prepare(second))).toMatchObject({ response: { outcome: 'target-tab-busy', currentUrl: null } });
  expect(await router.dispatch(prepare(third, 8))).toMatchObject({ response: { outcome: 'ready' } });
  expect(deps.getPageById).toHaveBeenCalledTimes(2);
  release(); await waiting;
});

it('keeps credentials bound to their own prepared tab even with out-of-order operations', async () => {
  const { router, deps } = setup();
  await router.dispatch(prepare(first)); await router.dispatch(prepare(second, 8));
  const secondRequest = inject('tx-second'), firstRequest = inject('tx-first');
  expect(await router.dispatch(request(second, secondRequest))).toMatchObject({ operationId: second, response: { outcome: 'injected' } });
  expect(await router.dispatch(request(first, firstRequest))).toMatchObject({ operationId: first, response: { outcome: 'injected' } });
  expect(vi.mocked(deps.sendStep).mock.calls.map(call => call[0])).toEqual([8, 7]);
  expect(secondRequest.values[0]!.value).toBe(''); expect(firstRequest.values[0]!.value).toBe('');
});

it('does not accept credentials for an unknown operation', async () => {
  const { router, deps } = setup();
  const secret = inject('unknown');
  expect(await router.dispatch(request(first, secret))).toMatchObject({ response: { outcome: 'rejected' } });
  expect(secret.values[0]!.value).toBe('');
  expect(deps.getActivePage).not.toHaveBeenCalled(); expect(deps.sendStep).not.toHaveBeenCalled();
});

it('preserves an intentionally untargeted legacy preparation by pinning the initial active tab once', async () => {
  const getActivePage = vi.fn(async () => ({ id: 7, page: { url, documentId } }));
  const { router, deps } = setup({ getActivePage });
  const untargeted = request(first, { protocol: AGENT_INJECT_PROTOCOL, type: 'prepare', nonce: first.repeat(2) });
  expect(await router.dispatch(untargeted)).toMatchObject({ response: { outcome: 'ready' } });
  expect(await router.dispatch(prepare(second, 7))).toMatchObject({ response: { outcome: 'target-tab-busy' } });
  getActivePage.mockResolvedValue({ id: 8, page: { url, documentId } });
  expect(await router.dispatch(request(first, inject('legacy-pinned')))).toMatchObject({ response: { outcome: 'injected' } });
  expect(getActivePage).toHaveBeenCalledOnce();
  expect(vi.mocked(deps.sendStep).mock.calls.map(call => call[0])).toEqual([7]);
});

it('never replaces an unavailable explicit target with the active tab', async () => {
  const { router, deps } = setup({ getPageById: async () => null });
  expect(await router.dispatch(prepare(first))).toMatchObject({ response: { outcome: 'target-tab-unavailable' } });
  expect(deps.getActivePage).not.toHaveBeenCalled();
  expect(deps.sendStep).not.toHaveBeenCalled();
});

it('does not resurrect an operation cancelled while resolving an intentionally untargeted preparation', async () => {
  let release!: (value: { id: number; page: { url: string; documentId: string } }) => void;
  const { router, deps } = setup({ getActivePage: () => new Promise(resolve => { release = resolve; }) });
  const preparing = router.dispatch(request(first, { protocol: AGENT_INJECT_PROTOCOL, type: 'prepare', nonce: first.repeat(2) }));
  const closing = router.close(first);
  release({ id: 7, page: { url, documentId } });
  expect(await preparing).toMatchObject({ response: { outcome: 'provider-unavailable' } });
  await closing;
  expect(deps.getPageById).not.toHaveBeenCalled();
  expect(await router.dispatch(prepare(second))).toMatchObject({ response: { outcome: 'ready' } });
});

it('cancels one operation without clearing another operation or allowing late DOM writes', async () => {
  let release!: () => void;
  const { router, deps } = setup();
  await router.dispatch(prepare(first)); await router.dispatch(prepare(second, 8));
  vi.mocked(deps.getPageById).mockImplementationOnce(async id => {
    await new Promise<void>(resolve => { release = resolve; });
    return { id, page: { url, documentId } };
  });
  const pending = router.dispatch(request(first, inject('cancelled')));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const closing = router.close(first);
  expect(await router.dispatch(prepare(third))).toMatchObject({ response: { outcome: 'target-tab-busy' } });
  expect(await router.dispatch(request(second, inject('survivor')))).toMatchObject({ response: { outcome: 'injected' } });
  release(); await pending; await closing;
  expect(vi.mocked(deps.sendStep).mock.calls.map(call => call[0])).toEqual([8]);
  expect(await router.dispatch(prepare(third))).toMatchObject({ response: { outcome: 'ready' } });
});

it('does not release a deferred-submit tab until its cancellation finishes', async () => {
  let release!: () => void;
  const cancelDeferred = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const { router } = setup({
    inspectLiveLogin: async () => fixture.inject.form as AgentInjectForm,
    fillDeferred: async (_id, message) => ({ ok: true, submitReady: { ...fixture.submitReady.submitReady, pendingId: message.pendingId,
      submitSelector: `palladin-live:${message.pendingId}:${'3'.repeat(32)}` } }),
    cancelDeferred,
  });
  try {
    await router.dispatch(prepare(first, 7, true));
    const filled = await router.dispatch(request(first, { ...structuredClone(fixture.inject), expiresAt: Date.now() + 10_000 }));
    expect(filled).toMatchObject({ response: { outcome: 'submit-ready' } });
    const closing = router.close(first);
    const repeatedClose = router.close(first);
    await vi.waitFor(() => expect(cancelDeferred).toHaveBeenCalledOnce());
    expect(await router.dispatch(prepare(second))).toMatchObject({ response: { outcome: 'target-tab-busy' } });
    release(); await closing; await repeatedClose;
    expect(await router.dispatch(prepare(second))).toMatchObject({ response: { outcome: 'ready' } });
  } finally { release?.(); }
});

it('does not retarget an existing operation and wipes malformed envelope values', async () => {
  const { router, deps } = setup();
  await router.dispatch(prepare(first));
  await expect(router.dispatch(prepare(first, 8))).rejects.toThrow('Operation message order');
  expect(deps.getPageById).toHaveBeenCalledTimes(1);
  const secret = inject('malformed');
  await expect(router.dispatch({ ...request(second, secret), unexpected: true })).rejects.toThrow('Invalid operation envelope');
  expect(secret.values[0]!.value).toBe('');
  expect(deps.sendStep).not.toHaveBeenCalled();
});

it('expires abandoned preparations and rejects late credentials without a DOM write', async () => {
  vi.useFakeTimers();
  const { router, deps } = setup();
  await router.dispatch(prepare(first));
  await vi.advanceTimersByTimeAsync(360_000);
  const late = inject('late');
  expect(await router.dispatch(request(first, late))).toMatchObject({ response: { outcome: 'rejected' } });
  expect(late.values[0]!.value).toBe('');
  expect(deps.sendStep).not.toHaveBeenCalled();
  expect(await router.dispatch(prepare(second))).toMatchObject({ response: { outcome: 'ready' } });
});

it('probes an exact target without reserving the tab or touching a form', async () => {
  const probeTarget = vi.fn(async () => 'match' as const);
  const { router, deps } = setup({ probeTarget });
  await router.dispatch(prepare(first));
  const probe = { protocol: AGENT_INJECT_PROTOCOL, type: 'target.probe', nonce: second.repeat(2),
    targetTabId: 7, targetUrl: url };
  expect(await router.dispatch(request(second, probe))).toEqual({
    protocol: AGENT_INJECT_PROTOCOL, type: 'operation.result', operationId: second,
    response: { protocol: AGENT_INJECT_PROTOCOL, type: 'target.probe.result', nonce: probe.nonce, outcome: 'match' },
  });
  expect(probeTarget).toHaveBeenCalledWith(7, url);
  expect(deps.getPageById).toHaveBeenCalledOnce();
  expect(deps.sendStep).not.toHaveBeenCalled();
  await router.close(first);
  expect(await router.dispatch(prepare(third))).toMatchObject({ response: { outcome: 'ready' } });
});

it('rejects malformed probes and wipes attempted credential payloads without forwarding', async () => {
  const probeTarget = vi.fn(async () => 'match' as const);
  const { router } = setup({ probeTarget });
  await router.dispatch(prepare(first));
  for (const operationId of [first, second]) {
    const body = { protocol: AGENT_INJECT_PROTOCOL, type: 'target.probe', nonce: second.repeat(2),
      targetTabId: 7, targetUrl: url, values: [{ entryFieldId: 'credential.password', value: 'synthetic-canary' }] };
    await expect(router.dispatch(request(operationId, body))).rejects.toThrow();
    expect(body.values[0]?.value).toBe('');
  }
  expect(probeTarget).not.toHaveBeenCalled();
});

it('orders a cancelled target probe result before its close acknowledgement without disturbing another tab', async () => {
  let release!: () => void;
  const { router } = setup({ probeTarget: async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return 'match';
  } });
  await router.dispatch(prepare(first, 8));
  const order: string[] = [];
  const probe = router.dispatch(request(second, { protocol: AGENT_INJECT_PROTOCOL, type: 'target.probe',
    nonce: second.repeat(2), targetTabId: 7, targetUrl: url })).then(result => { order.push(result.type); return result; });
  const close = router.dispatch({ protocol: AGENT_INJECT_PROTOCOL, type: 'operation.close', operationId: second })
    .then(result => { order.push(result.type); });
  try {
    expect(await router.dispatch(request(first, inject('survivor-during-probe')))).toMatchObject({ response: { outcome: 'injected' } });
    expect(order).toEqual([]);
  } finally { release(); await probe; await close; }
  expect(order).toEqual(['operation.result', 'operation.closed']);
  expect(await router.dispatch(prepare(third, 7))).toMatchObject({ response: { outcome: 'ready' } });
});
