import { expect, it } from 'vitest';
import { parseAgentCaptureRequest, isAgentCaptureOutcome } from './agent-capture';
const request = { protocol: 'palladin.inject-provider.v1', type: 'capture', transactionId: 'tx', targetUrl: 'https://example.com/a', fields: [{ entryFieldId: 'credential.password', selector: '#p', read: 'value' }] };
it('accepts declarative capture and rejects executable or ambiguous declarations', () => {
  expect(parseAgentCaptureRequest(request)).toEqual(request);
  for (const patch of [{ fields: [] }, { fields: Array(33).fill(request.fields[0]) }, { fields: [request.fields[0], request.fields[0]] }, { targetUrl: 'http://example.com' }, { script: 'return x' }, { fields: [{ ...request.fields[0], read: 'innerHTML' }] }, { fields: [{ ...request.fields[0], selector: ' #p' }] }]) expect(parseAgentCaptureRequest({ ...request, ...patch })).toBeNull();
});
it('requires bounded UTF8 values and value-free failures', () => {
  expect(isAgentCaptureOutcome({ outcome: 'captured', values: [{ entryFieldId: 'x', value: '' }] })).toBe(true);
  expect(isAgentCaptureOutcome({ outcome: 'captured', values: [{ entryFieldId: 'x', value: 'é'.repeat(32769) }] })).toBe(false);
  expect(isAgentCaptureOutcome({ outcome: 'rejected', values: [] })).toBe(false);
});
it('rejects invalid identifiers, duplicate selectors, excess keys and non-HTTPS credential URLs', () => {
  for (const field of [
    { ...request.fields[0], entryFieldId: '' }, { ...request.fields[0], entryFieldId: 'x'.repeat(129) },
    { ...request.fields[0], selector: '' }, { ...request.fields[0], selector: 'x'.repeat(1025) },
    { ...request.fields[0], selector: '#p\0' }, { ...request.fields[0], script: 'x' },
  ]) expect(parseAgentCaptureRequest({ ...request, fields: [field] })).toBeNull();
  expect(parseAgentCaptureRequest({ ...request, fields: [request.fields[0], { ...request.fields[0], entryFieldId: 'other' }] })).toBeNull();
  for (const targetUrl of ['https://user:pass@example.com', ' https://example.com', 'javascript:alert(1)']) expect(parseAgentCaptureRequest({ ...request, targetUrl })).toBeNull();
  expect(isAgentCaptureOutcome({ outcome: 'captured', values: Array.from({ length: 5 }, (_, i) => ({ entryFieldId: `f${i}`, value: 'x'.repeat(65536) })) })).toBe(false);
});
