// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSecretCapture } from './secret-capture';
import type { SecretDetectionOptions } from './secret-detection';
import type { SecretCaptureContentCommand } from '@shared/messaging/secret-capture';
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); vi.restoreAllMocks(); });
it.each(['input', 'select', 'textarea'])('routes changes in an externally associated %s to its explicit form owner', async tag => {
  vi.useFakeTimers();
  document.body.innerHTML = `<form id="payment"></form><section><${tag} form="payment"></${tag}><input autocomplete="cc-name" value="Unrelated sibling"></section>`;
  const events = new Map<string, EventListener>(); const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => { if (typeof listener === 'function') events.set(type, listener); add(type, listener, options); });
  const detect = vi.fn((_doc: Document, _options?: SecretDetectionOptions) => []);
  const capture = startSecretCapture(document, 'local', { detect, send: async () => ({ status: 'empty' }), url: () => 'https://pay.example.test/' });
  await vi.advanceTimersByTimeAsync(400); detect.mockClear();
  events.get('change')!({ isTrusted: true, target: document.querySelector('[form]'), type: 'change' } as unknown as Event);
  await vi.advanceTimersByTimeAsync(400);
  expect(detect.mock.calls.map(call => call[1]?.scope)).toEqual([document.querySelector('form')]);
  capture.stop();
});
describe('live secret capture', () => {
  it('observes keys initially but does not capture synthetic card autofill', async () => {
    vi.useFakeTimers(); document.body.innerHTML = '<form><input autocomplete="cc-number"></form>';
    const sent: SecretCaptureContentCommand[] = [];
    const detect = vi.fn(() => [{ kind: 'key', value: 'synthetic-api-value' }, { kind: 'card', cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '' }] as const);
    const capture = startSecretCapture(document, 'local', { send: async command => { sent.push(command); return { status: 'empty' }; }, detect, url: () => 'https://example.test/' });
    await vi.advanceTimersByTimeAsync(400);
    expect(sent.filter(c => c.type === 'observe').map(c => c.type === 'observe' ? c.candidate.kind : '')).toEqual(['key']);
    document.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    expect(sent.filter(c => c.type === 'observe').every(c => c.type === 'observe' && c.candidate.kind === 'key')).toBe(true);
    capture.stop();
  });
  it('stops pending scans and never observes secrets when locked', async () => {
    vi.useFakeTimers(); const detect = vi.fn((_doc: Document, _options?: SecretDetectionOptions) => []); const sent: SecretCaptureContentCommand[] = [];
    const capture = startSecretCapture(document, 'local', { send: async command => { sent.push(command); return { status: 'locked' }; }, detect, url: () => 'https://example.test/' });
    await vi.advanceTimersByTimeAsync(400); expect(detect).toHaveBeenCalled();
    capture.stop(); document.body.append(document.createElement('output')); await vi.advanceTimersByTimeAsync(400);
    expect(sent.some(c => c.type === 'observe')).toBe(false);
  });
});

it('reserves generated-result intent for a changed local section after trusted action', async () => {
  vi.useFakeTimers(); document.body.innerHTML = '<section id="keys"><button>Generate</button><output></output></section><section id="other"><output></output></section>';
  const events = new Map<string, EventListener>(); const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => { if (typeof listener === 'function') events.set(type, listener); add(type, listener, options); });
  const detect = vi.fn((_doc: Document, _options?: SecretDetectionOptions) => []);
  const capture = startSecretCapture(document, 'local', { detect, send: async () => ({ status: 'empty' }), url: () => 'https://example.test/' });
  await vi.advanceTimersByTimeAsync(400); detect.mockClear();
  const button = document.querySelector('button')!;
  events.get('click')!({ isTrusted: false, target: button, type: 'click' } as unknown as Event);
  document.querySelector('#keys output')!.textContent = 'synthetic-result'; await vi.advanceTimersByTimeAsync(400);
  expect(detect.mock.calls.every(call => !(call[1] as { trustedGeneratedResult?: boolean } | undefined)?.trustedGeneratedResult)).toBe(true);
  detect.mockClear(); events.get('click')!({ isTrusted: true, target: button, type: 'click' } as unknown as Event);
  document.querySelector('#other output')!.textContent = 'unrelated'; await vi.advanceTimersByTimeAsync(400);
  expect(detect.mock.calls.every(call => !(call[1] as { trustedGeneratedResult?: boolean } | undefined)?.trustedGeneratedResult)).toBe(true);
  detect.mockClear(); document.querySelector('#keys output')!.textContent = 'new-result'; await vi.advanceTimersByTimeAsync(400);
  expect(detect).toHaveBeenCalledWith(document, { scope: document.querySelector('#keys output'), trustedGeneratedResult: true });
  capture.stop();
});

it('observes generated output changes inside discovered open shadow roots', async () => {
  vi.useFakeTimers(); const host = document.createElement('div'); document.body.append(host);
  const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<section><button>Generate</button><output></output></section>';
  const events = new Map<string, EventListener>(); const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => { if (typeof listener === 'function') events.set(type, listener); add(type, listener, options); });
  const detect = vi.fn((_doc: Document, _options?: SecretDetectionOptions) => []);
  const capture = startSecretCapture(document, 'local', { detect, send: async () => ({ status: 'empty' }), url: () => 'https://example.test/' });
  await vi.advanceTimersByTimeAsync(400); detect.mockClear();
  events.get('click')!({ isTrusted: true, target: host, composedPath: () => [root.querySelector('button')!], type: 'click' } as unknown as Event);
  root.querySelector('output')!.textContent = 'changed-output'; await vi.advanceTimersByTimeAsync(400);
  expect(detect).toHaveBeenCalledWith(document, { scope: root.querySelector('output'), trustedGeneratedResult: true });
  capture.stop(); detect.mockClear(); root.querySelector('output')!.textContent = 'after-stop'; await vi.advanceTimersByTimeAsync(400);
  expect(detect).not.toHaveBeenCalled();
});

it('does not lose generated results behind simultaneous button and sibling output mutations', async () => {
  vi.useFakeTimers(); document.body.innerHTML = '<section><button>Generate</button><output id="one"></output><output id="two"></output></section>';
  const events = new Map<string, EventListener>(); const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => { if (typeof listener === 'function') events.set(type, listener); add(type, listener, options); });
  const detect = vi.fn((_doc: Document, _options?: SecretDetectionOptions) => []);
  const capture = startSecretCapture(document, 'local', { detect, send: async () => ({ status: 'empty' }), url: () => 'https://example.test/' });
  await vi.advanceTimersByTimeAsync(400); detect.mockClear();
  const button = document.querySelector('button')!;
  events.get('click')!({ isTrusted: true, target: button, type: 'click' } as unknown as Event);
  button.textContent = 'Done'; document.querySelector('#one')!.textContent = 'first'; document.querySelector('#two')!.textContent = 'second';
  await vi.advanceTimersByTimeAsync(400);
  expect(detect).toHaveBeenCalledWith(document, { scope: document.querySelector('#one'), trustedGeneratedResult: true });
  expect(detect).toHaveBeenCalledWith(document, { scope: document.querySelector('#two'), trustedGeneratedResult: true }); capture.stop();
});

it('admits a directly body-owned PAN under its own scope without document-level metadata', async () => {
  vi.useFakeTimers(); document.body.innerHTML = '<input autocomplete="cc-number"><aside><input autocomplete="cc-name"></aside>';
  const events = new Map<string, EventListener>(); const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => { if (typeof listener === 'function') events.set(type, listener); add(type, listener, options); });
  const detect = vi.fn((_doc: Document, _options?: SecretDetectionOptions) => []);
  const capture = startSecretCapture(document, 'local', { detect, send: async () => ({ status: 'empty' }), url: () => 'https://pay.example.test/' });
  await vi.advanceTimersByTimeAsync(400); detect.mockClear();
  const input = document.querySelector('input')!;
  events.get('input')!({ isTrusted: true, target: input, type: 'input' } as unknown as Event);
  await vi.advanceTimersByTimeAsync(400);
  expect(detect.mock.calls.some(call => call[1]?.scope === input)).toBe(true);
  expect(detect.mock.calls.some(call => call[1]?.scope === document.body)).toBe(false);
  capture.stop();
});

it('uses stable opaque group identities for card enrichment without grouping distinct forms', async () => {
  vi.useFakeTimers(); document.body.innerHTML = '<form id="one"><input></form><form id="two"><input></form>';
  const events = new Map<string, EventListener>(); const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => { if (typeof listener === 'function') events.set(type, listener); add(type, listener, options); });
  const sent: SecretCaptureContentCommand[] = [];
  const detect = (_doc: Document, options?: SecretDetectionOptions) => options?.cardScopeId && options.scope ? [{
    kind: 'card' as const, scopeId: options.cardScopeId(options.scope), cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '',
  }] : [];
  const capture = startSecretCapture(document, 'local', { detect, send: async command => { sent.push(command); return { status: 'empty' }; }, url: () => 'https://pay.example.test/' });
  await vi.advanceTimersByTimeAsync(400);
  for (const selector of ['#one input', '#one input', '#two input']) {
    events.get('input')!({ isTrusted: true, target: document.querySelector(selector), type: 'input' } as unknown as Event);
    await vi.advanceTimersByTimeAsync(400);
  }
  const ids = sent.flatMap(command => command.type === 'observe' && command.candidate.kind === 'card' ? [command.candidate.scopeId] : []);
  expect(ids).toHaveLength(3); expect(ids[0]).toMatch(/^[a-f0-9]{32}$/); expect(ids[1]).toBe(ids[0]); expect(ids[2]).not.toBe(ids[0]);
  capture.stop();
});

it('shows value-free locked re-capture guidance and never sends or reuses a locked observation', async () => {
  vi.useFakeTimers(); document.body.innerHTML = '<section><output></output></section>';
  const sent: SecretCaptureContentCommand[] = [];
  let locked = true;
  const detect = vi.fn(() => locked ? [{ kind: 'key' as const, value: 'synthetic-locked-api-value' }] : []);
  const capture = startSecretCapture(document, 'local', { detect, send: async command => { sent.push(command); return { status: locked ? 'locked' : 'empty' }; }, url: () => 'https://pay.example.test/' });
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('palladin-capture')).not.toBeNull();
  expect(sent.some(command => command.type === 'observe')).toBe(false);
  locked = false; await capture.refresh(true); await vi.advanceTimersByTimeAsync(400);
  expect(sent.some(command => command.type === 'observe')).toBe(false);
  capture.stop();
});
