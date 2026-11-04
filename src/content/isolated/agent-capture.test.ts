// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { captureAgentFields } from './agent-capture';
const docId = 'd'.repeat(32), url = 'https://example.com/a';
const message = { channel: 'palladin.agent-capture/read' as const, documentId: docId, targetUrl: url, fields: [
  { entryFieldId: 'username', selector: '#u', read: 'value' as const },
  { entryFieldId: 'password', selector: '#p', read: 'value' as const },
  { entryFieldId: 'custom.password2', selector: '#p2', read: 'value' as const },
  { entryFieldId: 'token', selector: '#t', read: 'textContent' as const },
] };
const visible = { isVisible: (el: HTMLElement) => !el.hidden };
function run(m = message, location = () => url, id = docId) { return captureAgentFields(document, m, id, location, visible); }
it('reads multiple controls and div text atomically', () => {
  document.body.innerHTML = '<input id=u value=alice><input id=p type=password value=one><input id=p2 type=password value=two><div id=t>token</div>';
  expect(run()).toEqual({ outcome: 'captured', values: [{ entryFieldId: 'username', value: 'alice' }, { entryFieldId: 'password', value: 'one' }, { entryFieldId: 'custom.password2', value: 'two' }, { entryFieldId: 'token', value: 'token' }] });
});
it('fails closed on absent, ambiguous, hidden, unsupported and changed targets', () => {
  for (const html of ['<input id=u>', '<input id=u><input id=u>', '<input id=u hidden>', '<div id=u>abc</div>']) {
    document.body.innerHTML = html;
    expect(run()).toEqual({ outcome: 'rejected' });
  }
  document.body.innerHTML = '<input id=u value=alice>';
  const m = { ...message, fields: [message.fields[0]] };
  expect(run(m, () => url + '/changed')).toEqual({ outcome: 'rejected' });
  expect(run(m, () => url, 'e'.repeat(32))).toEqual({ outcome: 'rejected' });
  let reads = 0;
  expect(run(m, () => ++reads === 1 ? url : url + '/changed')).toEqual({ outcome: 'rejected' });
  expect(run({ ...m, fields: [{ ...m.fields[0], selector: '[' }] })).toEqual({ outcome: 'rejected' });
});
it('rejects a single missing, ambiguous, hidden or unsupported field and aliases of one element', () => {
  const m = { ...message, fields: [message.fields[0]] };
  for (const html of ['', '<input id=u><input id=u>', '<input id=u hidden>', '<div id=u>abc</div>', '<input id=u type=file>']) {
    document.body.innerHTML = html; expect(run(m)).toEqual({ outcome: 'rejected' });
  }
  document.body.innerHTML = '<input id=u value=alice>';
  expect(run({ ...m, fields: [message.fields[0], { entryFieldId: 'other', selector: 'input', read: 'value' }] })).toEqual({ outcome: 'rejected' });
  (document.querySelector('input') as HTMLInputElement).value = 'é'.repeat(32769);
  expect(run(m)).toEqual({ outcome: 'rejected' });
});
