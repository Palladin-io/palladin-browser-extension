import { expect, it } from 'vitest';
import { isLiveProbeMessage, parseLiveLoginProbe } from './agent-live';
import { parseAgentInjectionRequest } from './agent-inject';
const form = { version: 1, steps: [{ fields: [{ entryFieldId: 'credential.username', control: 'username', selector: 'palladin-live:one:field' }],
  submit: { action: 'click', selector: 'palladin-live:one:submit' } }] };
it('accepts only bounded value-free continuation probe envelopes', () => {
  const request = { channel: 'palladin.agent-live/probe', documentId: 'a'.repeat(32), targetUrl: 'https://login.example.test/' };
  expect(isLiveProbeMessage(request)).toBe(true);
  expect(isLiveProbeMessage({ ...request, values: [] })).toBe(false);
  expect(isLiveProbeMessage({ ...request, documentId: 'invalid' })).toBe(false);
  expect(parseLiveLoginProbe({ outcome: 'ready', form })).toEqual({ outcome: 'ready', form });
  expect(parseLiveLoginProbe({ outcome: 'ready', form, values: [] })).toBeNull();
  expect(parseLiveLoginProbe({ outcome: 'challenge' })).toEqual({ outcome: 'challenge' });
  expect(parseLiveLoginProbe({ outcome: 'no-form', html: 'untrusted' })).toBeNull();
});
it('keeps continuation opt-in boolean and rejects arbitrary continuation parameters', () => {
  const request = { protocol: 'palladin.inject-provider.v1', type: 'inject', transactionId: 'tx1', grantId: 'grant1', entryId: 'entry1',
    expectedDomain: 'login.example.test', form, values: [{ entryFieldId: 'credential.username', value: 'synthetic' }] };
  expect(parseAgentInjectionRequest({ ...request, continueLive: true })?.continueLive).toBe(true);
  expect(parseAgentInjectionRequest(request)?.continueLive).toBeUndefined();
  expect(parseAgentInjectionRequest({ ...request, continueLive: 'yes' })).toBeNull();
  expect(parseAgentInjectionRequest({ ...request, continueLive: true, nextTab: 3 })).toBeNull();
});
