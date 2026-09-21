// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveLogin } from '../../content/isolated/agent-live-login';
import { AGENT_INJECT_STEP_CHANNEL } from '@shared/messaging';
import type { AgentInjectForm } from '@shared/messaging';
import { handleNativeAgentMessage, type AgentFillDeps, type AgentProviderSession } from './native-provider';

let elapsed = 0;
beforeEach(() => { elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed); });
afterEach(() => vi.restoreAllMocks());
const doc = 'd'.repeat(32), nextDoc = 'e'.repeat(32), url = 'https://signin.example.test/start';
function form(field: 'username' | 'password' | 'totp', serial = '1'): AgentInjectForm {
  return { version: 1, steps: [{ fields: [{ entryFieldId: `credential.${field}`, control: field === 'totp' ? 'otp' : field,
    selector: `palladin-live:${serial}:field` }], submit: { action: 'click', selector: `palladin-live:${serial}:submit` } }] };
}
function fixture() {
  let current = { id: 7, page: { url, documentId: doc } };
  let next: { outcome: 'ready'; form: AgentInjectForm } | { outcome: 'challenge' | 'no-form' } = { outcome: 'ready', form: form('password', '2') };
  const provider = {
    getActivePage: vi.fn(async () => current), getPageById: vi.fn(async () => current),
    inspectLiveLogin: vi.fn(async () => form('username')),
    probeLiveLogin: vi.fn(async () => next),
    sendStep: vi.fn(async () => ({ ok: true } as const)),
    probeTransition: vi.fn(async () => ({ status: 'ready' } as const)), wait: vi.fn(async (ms: number) => { elapsed += ms; }),
  } satisfies AgentFillDeps;
  const session: AgentProviderSession = { prepared: null };
  const replay = { consume: vi.fn(async () => true) };
  const send = (raw: unknown) => handleNativeAgentMessage(provider, replay, session, raw);
  const prepare = () => send({ protocol: 'palladin.inject-provider.v1', type: 'prepare', nonce: 'a'.repeat(64), targetTabId: 7, targetUrl: url, liveDetection: true });
  const inject = (plan = form('username'), id = 'tx-1', overrides = {}) => {
    const request = { protocol: 'palladin.inject-provider.v1', type: 'inject', transactionId: id, grantId: 'grant-1', entryId: 'entry-1',
      expectedDomain: 'example.test', form: plan, values: plan.steps[0]!.fields.map(field => ({ entryFieldId: field.entryFieldId, value: 'synthetic-only' })),
      continueLive: true, ...overrides };
    return { request, result: send(request) };
  };
  return { provider, session, replay, prepare, inject, next: (value: typeof next) => { next = value; },
    page: (value: typeof current) => { current = value; } };
}
describe('one-session live continuation', () => {
  it.each([false, true])('binds fresh password and TOTP plans after one submit, document replacement=%s', async navigation => {
    const f = fixture(); await f.prepare();
    if (navigation) f.provider.sendStep.mockImplementationOnce(async () => { f.page({ id: 7, page: { url: 'https://signin.example.test/password', documentId: nextDoc } }); return { ok: true }; });
    const first = f.inject();
    expect(await first.result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'ready', liveForm: form('password', '2'), documentId: navigation ? nextDoc : doc } });
    expect(first.request.values.every(value => value.value === '')).toBe(true);
    f.next({ outcome: 'ready', form: form('totp', '3') });
    expect(await f.inject(form('password', '2'), 'tx-2').result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'ready', liveForm: form('totp', '3') } });
    f.next({ outcome: 'no-form' });
    expect(await f.inject(form('totp', '3'), 'tx-3').result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'no-form' } });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(3);
    expect(f.session.prepared).toBeNull();
  });
  it.each(['grantId', 'entryId', 'expectedDomain'])('rejects changed %s and consumes the continuation', async key => {
    const f = fixture(); await f.prepare(); await f.inject().result;
    expect(await f.inject(form('password', '2'), 'tx-2', { [key]: key === 'expectedDomain' ? 'signin.example.test' : 'other' }).result).toMatchObject({ outcome: 'rejected' });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(1);
    expect(f.session.prepared).toBeNull();
  });
  it.each(['https://other.example.test/password', 'http://signin.example.test/password'])('never continues onto %s', async nextUrl => {
    const f = fixture(); await f.prepare();
    f.provider.sendStep.mockImplementationOnce(async () => { f.page({ id: 7, page: { url: nextUrl, documentId: nextDoc } }); return { ok: true }; });
    expect(await f.inject().result).toMatchObject({ outcome: 'injected', continuation: { outcome: nextUrl.startsWith('http:') ? 'insecure-origin' : 'origin-mismatch' } });
    expect(f.provider.probeLiveLogin).not.toHaveBeenCalled();
  });
  it('times out an unchanged submitted stage without replaying it', async () => {
    const f = fixture(); await f.prepare(); f.next({ outcome: 'ready', form: form('username', 'fresh-refs') });
    expect(await f.inject().result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'timeout' } });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(1);
    expect(f.session.prepared).toBeNull();
  });
  it('returns a challenge without discovering or submitting a second plan', async () => {
    const f = fixture(); await f.prepare(); f.next({ outcome: 'challenge' });
    expect(await f.inject().result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'challenge' } });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(1);
  });
  it('rejects an expired chain before the next secret write', async () => {
    vi.useFakeTimers();
    try { const f = fixture(); await f.prepare(); await f.inject().result; vi.advanceTimersByTime(60_001);
      expect(await f.inject(form('password', '2'), 'tx-2').result).toMatchObject({ outcome: 'rejected' });
      expect(f.provider.sendStep).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('does not continue after an ambiguous transport failure or replay a delivery', async () => {
    const f = fixture(); await f.prepare();
    f.provider.sendStep.mockResolvedValueOnce(null as never);
    expect(await f.inject().result).toMatchObject({ outcome: 'provider-unavailable' });
    expect(f.provider.probeLiveLogin).not.toHaveBeenCalled();
    expect(await f.inject().result).toMatchObject({ outcome: 'provider-unavailable' });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(1);
  });
  it('rejects a replayed transaction without any DOM write', async () => {
    const f = fixture(); await f.prepare(); f.replay.consume.mockResolvedValue(false);
    expect(await f.inject().result).toMatchObject({ outcome: 'rejected' });
    expect(f.provider.sendStep).not.toHaveBeenCalled();
  });
  it('does not follow a replacement tab while waiting for the next stage', async () => {
    const f = fixture(); await f.prepare();
    f.provider.sendStep.mockImplementationOnce(async () => { f.page({ id: 8, page: { url, documentId: doc } }); return { ok: true }; });
    expect(await f.inject().result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'provider-unavailable' } });
  });
  it('rejects exact-origin drift after a ready continuation before writing', async () => {
    const f = fixture(); await f.prepare(); await f.inject().result;
    f.page({ id: 7, page: { url: 'https://child.signin.example.test/password', documentId: doc } });
    expect(await f.inject(form('password', '2'), 'tx-2').result).toMatchObject({ outcome: 'rejected' });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(1);
  });
  it('caps the session at eight submitted steps without extending the deadline', async () => {
    const f = fixture(); await f.prepare(); await f.inject().result;
    const expiry = f.session.liveChain!.expiresAt;
    f.session.liveChain!.steps = 7;
    expect(await f.inject(form('password', '2'), 'tx-2').result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'timeout' } });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(2);
    expect(expiry).toBeGreaterThan(Date.now());
    expect(f.session.liveChain).toBeNull();
  });
  it('allows an approved username carried beside a new password, but never repeats password or TOTP', async () => {
    const f = fixture(); await f.prepare();
    const combined: AgentInjectForm = { version: 1, steps: [{ fields: [...form('username', '2').steps[0]!.fields, ...form('password', '2').steps[0]!.fields.map(field => ({ ...field, selector: field.selector + '-password' }))], submit: form('password', '2').steps[0]!.submit }] };
    f.next({ outcome: 'ready', form: combined });
    expect(await f.inject().result).toMatchObject({ continuation: { outcome: 'ready', liveForm: combined } });
    expect(f.session.prepared?.requireExistingUsername).toBe(true);
    f.next({ outcome: 'ready', form: combined });
    expect(await f.inject(combined, 'tx-2').result).toMatchObject({ outcome: 'injected', continuation: { outcome: 'timeout' } });
    expect(f.provider.sendStep).toHaveBeenCalledTimes(2);
    expect(f.provider.sendStep.mock.calls[1]).toEqual([7, 'example.test', doc, combined.steps[0], expect.any(Array), true]);
  });
  it('runs observed AWS identifier then synthetic password and authenticator stages under one session', async () => {
    document.body.innerHTML = readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-18/page.html', 'utf8');
    const live = new LiveLogin(document, doc, () => url, () => true, { isVisible: element => !element.hidden });
    let submitted = 0;
    const owner = document.querySelector('form')!;
    owner.addEventListener('submit', event => {
      event.preventDefault(); submitted++;
      // Only the first DOM is observed AWS; transitions below are a synthetic
      // general SPA mechanism. No production handlers or account are involved.
      owner.innerHTML = submitted === 1 ? '<label>Password<input type="password" autocomplete="current-password"></label><button>Sign in</button>'
        : submitted === 2 ? '<label>Authenticator code<input autocomplete="one-time-code"></label><button>Verify</button>' : '<p>Neutral destination</p>';
    });
    const provider: AgentFillDeps = {
      getActivePage: async () => ({ id: 7, page: { url, documentId: doc } }),
      getPageById: async () => ({ id: 7, page: { url, documentId: doc } }),
      inspectLiveLogin: async () => live.inspect(url), probeLiveLogin: async () => live.probe(url),
      sendStep: async (_tab, expectedDomain, documentId, step, values) => live.fill({ channel: AGENT_INJECT_STEP_CHANNEL, expectedDomain, documentId, step, values }),
      fillDeferred: async (_tab, message) => live.fillDeferred(message), commitDeferred: async (_tab, message) => live.commitDeferred(message),
      cancelDeferred: async (_tab, pendingId) => live.cancelDeferred(pendingId),
      probeTransition: async () => ({ status: 'missing' }), wait: async ms => { elapsed += ms; },
    };
    const session: AgentProviderSession = { prepared: null }, guard = { consume: async () => true };
    try {
      await handleNativeAgentMessage(provider, guard, session, { protocol: 'palladin.inject-provider.v1', type: 'prepare', nonce: 'a'.repeat(64), targetTabId: 7, targetUrl: url, liveDetection: true });
      for (const [index, field] of ['username', 'password', 'totp'].entries()) {
        const currentForm = session.prepared!.liveForm!;
        expect(currentForm.steps[0]!.fields[0]!.entryFieldId).toBe(`credential.${field}`);
        let response = await handleNativeAgentMessage(provider, guard, session, { protocol: 'palladin.inject-provider.v1', type: 'inject', transactionId: `tx-${index}`, grantId: 'grant1', entryId: 'entry1',
          expectedDomain: 'signin.example.test', form: currentForm, continueLive: true,
          ...(currentForm.version === 2 ? { expiresAt: Date.now() + 10_000 } : {}),
          values: [{ entryFieldId: `credential.${field}`, value: field === 'username' ? 'synthetic@example.test' : field === 'password' ? 'Synthetic-password!42' : '123456' }] });
        if (currentForm.version === 2) {
          expect(response.outcome).toBe('submit-ready'); expect(submitted).toBe(index);
          response = await handleNativeAgentMessage(provider, guard, session, { protocol: 'palladin.inject-provider.v1', type: 'submit', transactionId: `commit-${index}`,
            preparedTransactionId: `tx-${index}`, grantId: 'grant1', entryId: 'entry1', expectedDomain: 'signin.example.test', expiresAt: Date.now() + 1000, submitReady: 'submitReady' in response ? response.submitReady : null });
        }
        expect(response).toMatchObject({ outcome: 'injected', continuation: { outcome: index < 2 ? 'ready' : 'no-form' } });
        expect(submitted).toBe(index + 1);
      }
    } finally { live.clear(); document.body.replaceChildren(); }
  });
});
