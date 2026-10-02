import { expect, it, vi } from 'vitest';
import { prepareLoginFrame, type FrameTransport } from './frame-routing';
import { handleNativeAgentMessage, type AgentProviderSession } from './native-provider';
import { AGENT_FRAME_LIST_CHANNEL } from '@shared/messaging/agent-frame';
const topUrl = 'https://appstoreconnect.apple.com/login', childUrl = 'https://idmsa.apple.com/appleauth/auth/signin';
const top = { id: 7, page: { url: topUrl, documentId: 'a'.repeat(32) } };
const childDocument = 'b'.repeat(32);
const form = { version: 2, steps: [{ fields: [{ entryFieldId: 'credential.username', control: 'username', selector: `palladin-live:${'a'.repeat(32)}:${'b'.repeat(32)}` }], submit: { action: 'deferred-native-click', selector: `palladin-live:${'a'.repeat(32)}:${'c'.repeat(32)}` } }] };
function fixture() {
  let frames: Awaited<ReturnType<FrameTransport['frames']>> = [
    { frameId: 0, parentFrameId: -1, processId: 1, errorOccurred: false, url: topUrl, documentId: 'outer-browser', documentLifecycle: 'active', frameType: 'outermost_frame' },
    { frameId: 2, parentFrameId: 0, parentDocumentId: 'outer-browser', processId: 2, errorOccurred: false, url: childUrl, documentId: 'child-browser', documentLifecycle: 'active', frameType: 'sub_frame' },
  ];
  let visible = [childUrl];
  let active = true;
  let revokeOnLookup = false;
  const send = vi.fn(async (_tab: number, browserDocument: string, raw: unknown) => {
    const message = raw as { channel: string };
    if (message.channel === AGENT_FRAME_LIST_CHANNEL) return visible;
    if (message.channel === 'palladin.tab/current-url') { if (revokeOnLookup) active = false; return { url: frames![1]!.url, documentId: browserDocument === 'child-browser' ? childDocument : 'c'.repeat(32) }; }
    if (message.channel === 'palladin.agent-live/inspect') return form;
    return { ok: false, outcome: 'stale-form-map' };
  });
  const transport: FrameTransport = { frames: async () => frames?.map(frame => ({ ...frame })) ?? null, send };
  return { transport, send, prepare: () => prepareLoginFrame(top, transport, () => active), hide: () => { visible = []; }, revokeOnLookup: () => { revokeOnLookup = true; },
    change: (field: string, value: unknown, index = 1) => { Object.assign(frames![index]!, { [field]: value }); },
    duplicate: () => { frames!.push({ ...frames![1]!, frameId: 3, documentId: 'other-browser' }); },
  };
}
it('targets messages to the browser-owned document, never broadcasts a credential to frames', async () => {
  const f = fixture(), selected = await f.prepare();
  expect(selected?.page.page?.url).toBe(childUrl);
  expect(selected?.form).toEqual(form);
  await selected!.deps.fillDeferred!(7, { channel: 'palladin.agent-live/deferred-fill', documentId: childDocument, pendingId: 'd'.repeat(32),
    expectedDomain: 'idmsa.apple.com', form: selected!.form, values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }], expiresAt: Date.now() + 1000 });
  expect(f.send.mock.calls.at(-1)?.slice(0, 2)).toEqual([7, 'child-browser']);
  expect(await selected!.deps.getPageById(8)).toBeNull();
});
it.each(['foreign', 'http', 'nested', 'cached', 'duplicate', 'hidden', 'outer-url', 'outer-document', 'child-document', 'child-path', 'native-disconnect'])('rejects %s after preparation before sending values', async scenario => {
  const f = fixture(), selected = await f.prepare();
  expect(selected).not.toBeNull();
  if (scenario === 'foreign') f.change('url', 'https://evil.example.test/');
  if (scenario === 'http') f.change('url', childUrl.replace('https:', 'http:'));
  if (scenario === 'nested') f.change('parentFrameId', 3);
  if (scenario === 'cached') f.change('documentLifecycle', 'cached');
  if (scenario === 'duplicate') f.duplicate();
  if (scenario === 'hidden') f.hide();
  if (scenario === 'native-disconnect') f.revokeOnLookup();
  if (scenario === 'outer-url') f.change('url', topUrl + '/other', 0);
  if (scenario === 'outer-document') f.change('documentId', 'replacement', 0);
  if (scenario === 'child-document') f.change('documentId', 'replacement');
  if (scenario === 'child-path') f.change('url', childUrl + '/other');
  f.send.mockClear();
  expect(await selected!.deps.fillDeferred!(7, { channel: 'palladin.agent-live/deferred-fill', documentId: childDocument,
    pendingId: 'd'.repeat(32), expectedDomain: 'idmsa.apple.com', form: selected!.form,
    values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }], expiresAt: Date.now() + 1000 })).toBeNull();
  expect(f.send.mock.calls.some(call => (call[2] as { channel: string }).channel === 'palladin.agent-live/deferred-fill')).toBe(false);
});
it.each(['foreign', 'http', 'duplicate', 'hidden', 'sandbox-origin'])('does not prepare a %s frame', async scenario => {
  const f = fixture();
  if (scenario === 'foreign') f.change('url', 'https://evil.example.test/');
  if (scenario === 'http') f.change('url', childUrl.replace('https:', 'http:'));
  if (scenario === 'duplicate') f.duplicate();
  if (scenario === 'hidden') f.hide();
  if (scenario === 'sandbox-origin') f.change('url', 'about:blank');
  expect(await f.prepare()).toBeNull();
});
it('checks the authenticated Entry host against the child before forwarding any values', async () => {
  const f = fixture();
  const deps = { getActivePage: async () => top, getPageById: async () => top, inspectLiveLogin: async () => null,
    prepareFrame: () => f.prepare(), sendStep: async () => null, probeTransition: async () => null };
  const session: AgentProviderSession = { prepared: null }, replay = { consume: async () => true };
  expect(await handleNativeAgentMessage(deps, replay, session, { protocol: 'palladin.inject-provider.v1', type: 'prepare',
    nonce: 'e'.repeat(64), targetTabId: 7, targetUrl: topUrl, liveDetection: true })).toMatchObject({ outcome: 'ready' });
  const values = [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }];
  expect(await handleNativeAgentMessage(deps, replay, session, { protocol: 'palladin.inject-provider.v1', type: 'inject', transactionId: 'tx',
    grantId: 'grant', entryId: 'entry', expectedDomain: 'appstoreconnect.apple.com', form, values, continueLive: true, expiresAt: Date.now() + 1000 })).toMatchObject({ outcome: 'rejected' });
  expect(values[0]!.value).toBe('');
  expect(f.send.mock.calls.some(call => (call[2] as { channel: string }).channel === 'palladin.agent-live/deferred-fill')).toBe(false);
});
