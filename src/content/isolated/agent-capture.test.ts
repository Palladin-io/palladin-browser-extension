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
it('rejects oversized text without materializing element textContent or reading later fields', () => {
  document.body.innerHTML = '<div id=t></div><input id=u value=alice>';
  const el = document.getElementById('t')!;
  el.append(document.createTextNode('x'.repeat(65537)));
  let materialized = false, laterRead = false;
  Object.defineProperty(el, 'textContent', { get: () => { materialized = true; throw new Error('must not concatenate'); } });
  Object.defineProperty(document.getElementById('u'), 'value', { get: () => { laterRead = true; return 'alice'; } });
  expect(run({ ...message, fields: [message.fields[3], message.fields[0]] })).toEqual({ outcome: 'rejected' });
  expect(materialized).toBe(false);
  expect(laterRead).toBe(false);
});
it('enforces aggregate UTF8 budget before reading subsequent fields', () => {
  document.body.innerHTML = Array.from({ length: 6 }, (_, i) => `<input id=f${i}>`).join('');
  let readAfterLimit = false;
  for (let i = 0; i < 5; i++) (document.getElementById(`f${i}`) as HTMLInputElement).value = 'é'.repeat(32768);
  Object.defineProperty(document.getElementById('f5'), 'value', { get: () => { readAfterLimit = true; return 'tail'; } });
  expect(run({ ...message, fields: Array.from({ length: 6 }, (_, i) => ({ entryFieldId: `f${i}`, selector: `#f${i}`, read: 'value' as const })) })).toEqual({ outcome: 'rejected' });
  expect(readAfterLimit).toBe(false);
});
it('collects bounded descendant text in document order without comments', () => {
  document.body.innerHTML = '<div id=t>one<span>two</span><!--ignored-->three</div>';
  expect(run({ ...message, fields: [message.fields[3]] })).toEqual({ outcome: 'captured', values: [{ entryFieldId: 'token', value: 'onetwothree' }] });
});
