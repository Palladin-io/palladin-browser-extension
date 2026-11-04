import { expect, it, vi } from 'vitest';
import { handleNativeAgentMessage, type AgentFillDeps, type AgentProviderSession } from './native-provider';
import { NativeOperationRouter } from './operation-router';
import { AGENT_INJECT_PROTOCOL as protocol } from '@shared/messaging';
const url = 'https://example.com/a', documentId = 'd'.repeat(32);
const prepare = { protocol, type: 'prepare', nonce: 'n'.repeat(32), targetTabId: 7, targetUrl: url, liveDetection: false };
const request = { protocol, type: 'capture', transactionId: 'tx', targetUrl: url, fields: [{ entryFieldId: 'password', selector: '#p', read: 'value' }] };
function fixture() {
  let page = { id: 7, page: { url, documentId } };
  const values = [{ entryFieldId: 'password', value: 'synthetic-secret' }];
  const captureFields = vi.fn(async () => ({ outcome: 'captured' as const, values }));
  const deps: AgentFillDeps = { getPageById: async () => page, getActivePage: async () => page, sendStep: async () => null, probeTransition: async () => null, captureFields };
  const seen = new Set<string>();
  const replay = { consume: async (id: string) => { if (seen.has(id)) return false; seen.add(id); return true; } };
  const session: AgentProviderSession = { prepared: null };
  return { deps, session, replay, values, captureFields, setPage: (next: typeof page) => { page = next; }, call: (raw: unknown) => handleNativeAgentMessage(deps, replay, session, raw) };
}
it('returns values only in capture.result once and consumes prepared state', async () => {
  const f = fixture(); await f.call(prepare);
  expect(await f.call(request)).toEqual({ protocol, type: 'capture.result', transactionId: 'tx', outcome: 'captured', values: f.values });
  expect(await f.call(request)).toEqual({ protocol, type: 'capture.result', transactionId: 'tx', outcome: 'provider-unavailable' });
  await f.call(prepare);
  expect(await f.call(request)).toMatchObject({ type: 'capture.result', outcome: 'rejected' });
  expect(f.captureFields).toHaveBeenCalledTimes(1);
});
it('rejects changed URL/document before and after reads, wiping delayed values', async () => {
  for (const after of [false, true]) for (const changed of [{ url: url + '/other', documentId }, { url, documentId: 'e'.repeat(32) }]) {
    const f = fixture(); await f.call(prepare);
    if (after) f.captureFields.mockImplementationOnce(async () => { f.setPage({ id: 7, page: changed }); return { outcome: 'captured', values: f.values }; });
    else f.setPage({ id: 7, page: changed });
    expect(await f.call(request)).toEqual({ protocol, type: 'capture.result', transactionId: 'tx', outcome: 'rejected' });
    if (after) expect(f.values[0].value).toBe('');
    else expect(f.captureFields).not.toHaveBeenCalled();
  }
});
it('malformed capture declarations fail as value-free capture results', async () => {
  const f = fixture(); await f.call(prepare);
  expect(await f.call({ ...request, fields: [] })).toEqual({ protocol, type: 'capture.result', transactionId: 'tx', outcome: 'rejected' });
});
it('operation cancellation drops and wipes an in-flight read', async () => {
  const f = fixture(), router = new NativeOperationRouter(f.deps, f.replay), operationId = 'a'.repeat(32);
  const wrap = (request: unknown) => ({ protocol, type: 'operation.request', operationId, request });
  await router.dispatch(wrap(prepare));
  let finish!: () => void;
  f.captureFields.mockImplementationOnce(async () => { await new Promise<void>(r => { finish = r; }); return { outcome: 'captured', values: f.values }; });
  const pending = router.dispatch(wrap(request));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const closed = router.close(operationId); finish();
  expect(await pending).toMatchObject({ response: { type: 'capture.result', outcome: 'provider-unavailable' } });
  await closed; expect(f.values[0].value).toBe(''); await router.dispose();
});
it('does not route unprepared capture as inject.result', async () => {
  const f = fixture(), router = new NativeOperationRouter(f.deps, f.replay);
  expect(await router.dispatch({ protocol, type: 'operation.request', operationId: 'b'.repeat(32), request })).toMatchObject({ response: { type: 'capture.result', outcome: 'rejected' } });
  await router.dispose();
});
