import { afterEach, expect, it, vi } from 'vitest';
import type { AgentInjectionRequest } from '@shared/messaging';
import { advanceLiveChain, type LiveChain } from './native-live';
import type { AgentFillDeps, AgentProviderSession, AgentTabState } from './native-provider';

afterEach(() => vi.restoreAllMocks());

function fixture(ipcMs = 0) {
  let elapsed = 0;
  const epoch = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => epoch + elapsed);
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  let page: AgentTabState = { id: 7, page: { url: 'https://login.example.test/feed', documentId: 'document-1' } };
  const deps: AgentFillDeps = {
    getActivePage: async () => page,
    getPageById: vi.fn(async () => { elapsed += ipcMs; return page; }),
    probeLiveLogin: vi.fn(async () => { elapsed += ipcMs; return { outcome: 'no-form' as const }; }),
    sendStep: vi.fn(async () => ({ ok: true as const })),
    probeTransition: async () => ({ status: 'ready' }),
    wait: async milliseconds => { elapsed += milliseconds; },
  };
  const chain: LiveChain = { origin: 'https://login.example.test', tabId: 7, grantId: 'grant', entryId: 'entry',
    expectedDomain: 'login.example.test', expiresAt: epoch + 60_000, submitted: new Set(), steps: 0 };
  const session: AgentProviderSession = { prepared: null, liveChain: chain };
  const request: AgentInjectionRequest = { protocol: 'palladin.inject-provider.v1', type: 'inject', transactionId: 'synthetic',
    grantId: chain.grantId, entryId: chain.entryId, expectedDomain: chain.expectedDomain,
    form: { version: 1, steps: [{ fields: [{ entryFieldId: 'credential.password', control: 'password', selector: 'synthetic-field' }],
      submit: { action: 'click', selector: 'synthetic-button' } }] }, values: [], continueLive: true };
  return { deps, chain, session, request, run: () => advanceLiveChain(deps, session, chain, request),
    elapsed: () => elapsed, advance: (ms: number) => { elapsed += ms; }, page: (value: AgentTabState) => { page = value; } };
}

it('ends stable absence by elapsed time despite slow IPC, without renewing the chain or submitting again', async () => {
  const f = fixture(250);
  const expiry = f.chain.expiresAt;
  expect(await f.run()).toEqual({ outcome: 'no-form' });
  expect(f.elapsed()).toBeGreaterThanOrEqual(2_000);
  expect(f.elapsed()).toBeLessThan(10_000);
  expect(vi.mocked(f.deps.probeLiveLogin!).mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(vi.mocked(f.deps.probeLiveLogin!).mock.calls.length).toBeLessThan(20);
  expect(f.chain.expiresAt).toBe(expiry);
  expect(f.chain.steps).toBe(1);
  expect(f.session.liveChain).toBeNull();
  expect(f.deps.sendStep).not.toHaveBeenCalled();
});

it('requires fresh absence observations spanning two seconds, not merely a slow first reply', async () => {
  const f = fixture();
  let reports = 0;
  vi.mocked(f.deps.probeLiveLogin!).mockImplementation(async () => {
    if (++reports === 1) { f.advance(2_500); return { outcome: 'no-form' }; }
    return { outcome: 'challenge' };
  });
  expect(await f.run()).toEqual({ outcome: 'challenge' });
  expect(reports).toBe(2);
});

it('observes a challenge appearing just before two seconds of absence', async () => {
  const f = fixture();
  vi.mocked(f.deps.probeLiveLogin!).mockImplementation(async () => f.elapsed() >= 2_000 ? { outcome: 'challenge' } : { outcome: 'no-form' });
  expect(await f.run()).toEqual({ outcome: 'challenge' });
});

it.each(['null-report', 'missing-page', 'url', 'document', 'repeated-form'] as const)('restarts stable absence after %s', async interruption => {
  const f = fixture();
  let reports = 0;
  let interrupted = false;
  vi.mocked(f.deps.probeLiveLogin!).mockImplementation(async () => {
    reports++;
    if (!interrupted && f.elapsed() >= 1_500) {
      interrupted = true;
      if (interruption === 'null-report') return null;
      if (interruption === 'repeated-form') return { outcome: 'ready', form: f.request.form };
      f.page({ id: 7, page: interruption === 'missing-page' ? null : {
        url: interruption === 'url' ? 'https://login.example.test/next' : 'https://login.example.test/feed',
        documentId: interruption === 'document' ? 'document-2' : 'document-1',
      } });
    } else if (interruption === 'missing-page' && interrupted) {
      f.page({ id: 7, page: { url: 'https://login.example.test/feed', documentId: 'document-1' } });
    }
    return { outcome: 'no-form' };
  });
  if (interruption === 'missing-page') {
    const read = f.deps.getPageById;
    let missingReads = 0;
    f.deps.getPageById = async tabId => {
      const page = await read(tabId);
      if (!page?.page && ++missingReads === 2) f.page({ id: 7, page: { url: 'https://login.example.test/feed', documentId: 'document-1' } });
      return page;
    };
  }
  expect(await f.run()).toEqual({ outcome: 'no-form' });
  expect(f.elapsed()).toBeGreaterThanOrEqual(3_500);
  expect(reports).toBeGreaterThan(2);
});

it.each(['null', 'changed-document', 'unchanged-form'] as const)('keeps %s inconclusive until the bounded timeout', async condition => {
  const f = fixture();
  let sequence = 0;
  vi.mocked(f.deps.probeLiveLogin!).mockImplementation(async () => {
    if (condition === 'null') return null;
    if (condition === 'unchanged-form') return { outcome: 'ready', form: f.request.form };
    f.page({ id: 7, page: { url: 'https://login.example.test/feed', documentId: `document-${++sequence}` } });
    return { outcome: 'no-form' };
  });
  expect(await f.run()).toEqual({ outcome: 'timeout' });
  expect(f.elapsed()).toBeLessThanOrEqual(10_000);
  expect(f.deps.sendStep).not.toHaveBeenCalled();
});
