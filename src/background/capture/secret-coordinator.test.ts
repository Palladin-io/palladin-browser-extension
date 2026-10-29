import { describe, expect, it } from 'vitest';
import { SecretCaptureCoordinator, type SecretCaptureSource } from './secret-coordinator';

const source: SecretCaptureSource = { tabId: 1, frameId: 2, browserDocumentId: 'frame', topDocumentId: 'top', documentId: 'local', url: 'https://pay.example.test/form' };
const candidate = { kind: 'key', value: 'synthetic-private-api-value' } as const;
function fixture() {
  let now = 1; let generation = 1; let live = true; let fail = false; let writes = 0;
  let prepare: (() => Promise<void>) | undefined;
  let mutedHook: (() => void) | undefined;
  const coordinator = new SecretCaptureCoordinator({ now: () => now,
    session: async () => ({ profileId: 'profile', generation, unlocked: generation > 0 }),
    current: async () => live, activeTabId: async () => 1, muted: async () => { mutedHook?.(); return false; },
    mute: async () => {},
    vaults: async () => { await prepare?.(); return [{ id: 'v', name: 'Personal', isDefault: true }]; },
    duplicate: async () => false,
    save: async (_entry, _vault, authorized) => { await prepare?.(); if (!await authorized()) throw Error(); if (fail) throw Error(); writes++; return { status: 'saved' }; },
  });
  return { coordinator, whileObserving: (hook: () => void) => { mutedHook = hook; }, setNow: (v: number) => { now = v; }, lock: () => { generation = 0; coordinator.clear(); }, navigate: () => { live = false; },
    failing: () => { fail = true; }, retry: () => { fail = false; }, prepare: (v: () => Promise<void>) => { prepare = v; }, writes: () => writes };
}
const entry = { entryType: 'key', label: 'Test', value: candidate.value } as const;
it('invalidates only candidate IDs belonging to the disconnected document or navigated tab', async () => {
  const f = fixture();
  const first = await f.coordinator.observe(candidate, source);
  const sibling = await f.coordinator.observe(candidate, { ...source, frameId: 3, browserDocumentId: 'sibling', documentId: 'sibling-local' });
  const other = await f.coordinator.observe(candidate, { ...source, tabId: 2, topDocumentId: 'other-top' });
  expect(first.status).toBe('accepted'); expect(sibling.status).toBe('accepted'); expect(other.status).toBe('accepted');
  expect(f.coordinator.disconnected(1, 'sibling')).toEqual(['id' in sibling ? sibling.id : '']);
  expect(await f.coordinator.review()).toMatchObject({ status: 'review', id: 'id' in first ? first.id : '' });
  expect(f.coordinator.clearTab(2)).toEqual(['id' in other ? other.id : '']);
  expect(await f.coordinator.review()).toMatchObject({ status: 'review', id: 'id' in first ? first.id : '' });
  expect(f.coordinator.clearTab(1)).toEqual(['id' in first ? first.id : '']);
  expect(await f.coordinator.review()).toEqual({ status: 'empty' }); f.coordinator.clear();
});
describe('secret capture coordinator', () => {
  it('suppresses repeated observations without extending fixed expiry', async () => {
    const f = fixture(); const first = await f.coordinator.observe(candidate, source);
    f.setNow(60_000); expect(await f.coordinator.observe(candidate, source)).toEqual(first);
    f.setNow(180_002); expect(await f.coordinator.review()).toEqual({ status: 'empty' });
  });
  it('binds review to current frame and active tab', async () => {
    const f = fixture(); await f.coordinator.observe(candidate, source); f.navigate();
    expect(await f.coordinator.review()).toEqual({ status: 'empty' });
  });
  it('clears secrets after lock during asynchronous review', async () => {
    const f = fixture(); await f.coordinator.observe(candidate, source);
    f.prepare(async () => f.lock()); expect(await f.coordinator.review()).toEqual({ status: 'stale' });
  });
  it('does not write when the document changes during save preparation', async () => {
    const f = fixture(); const result = await f.coordinator.observe(candidate, source);
    f.prepare(async () => f.navigate());
    expect(await f.coordinator.save(('id' in result ? result.id : ''), 'v', entry)).toEqual({ status: 'stale' }); expect(f.writes()).toBe(0);
  });
  it('preserves a failed mutation for retry and consumes success exactly once', async () => {
    const f = fixture(); const result = await f.coordinator.observe(candidate, source); f.failing();
    expect(await f.coordinator.save(('id' in result ? result.id : ''), 'v', entry)).toEqual({ status: 'error' }); f.retry();
    expect(await f.coordinator.save(('id' in result ? result.id : ''), 'v', entry)).toEqual({ status: 'saved' });
    expect(await f.coordinator.save(('id' in result ? result.id : ''), 'v', entry)).toEqual({ status: 'stale' }); expect(f.writes()).toBe(1);
  });
  it('dismisses without mutation and bounds the queue without replacing the first pending choice', async () => {
    const f = fixture(); const first = await f.coordinator.observe(candidate, source);
    for (let i = 0; i < 20; i++) await f.coordinator.observe({ ...candidate, value: `${candidate.value}-${i}` }, source);
    const review = await f.coordinator.review(); expect(review.status).toBe('review');
    if (review.status === 'review') expect(review.id).toBe('id' in first ? first.id : '');
    await f.coordinator.dismiss(('id' in first ? first.id : '')); expect(f.writes()).toBe(0);
    let count = 0;
    for (;;) { const r = await f.coordinator.review(); if (r.status !== 'review') break; count++; await f.coordinator.dismiss(r.id); }
    expect(count).toBe(7);
  });
  it('allows at most one save in flight and invalidates it on clear', async () => {
    const f = fixture(); const first = await f.coordinator.observe(candidate, source);
    let release!: () => void; f.prepare(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.coordinator.save(('id' in first ? first.id : ''), 'v', entry); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(await f.coordinator.save(('id' in first ? first.id : ''), 'v', entry)).toEqual({ status: 'busy' });
    f.lock(); release(); expect(await pending).toEqual({ status: 'stale' }); expect(f.writes()).toBe(0);
  });
});

it('suppresses dismissed material and never writes a locally identical item', async () => {
  const f = fixture(); const first = await f.coordinator.observe(candidate, source);
  await f.coordinator.dismiss('id' in first ? first.id : '');
  expect(await f.coordinator.observe(candidate, source)).toEqual({ status: 'muted' });
  expect(f.writes()).toBe(0);
});


it('does not retain an observation whose frame disconnects during asynchronous admission', async () => {
  const f = fixture(); f.whileObserving(() => f.coordinator.disconnected(source.tabId, source.browserDocumentId));
  expect(await f.coordinator.observe(candidate, source)).toEqual({ status: 'stale' });
  expect(await f.coordinator.review()).toEqual({ status: 'empty' });
});

it('dismisses the addressed later source candidate while preserving the first queued choice', async () => {
  const f = fixture(); const first = await f.coordinator.observe(candidate, source);
  const secondCandidate = { ...candidate, value: 'synthetic-second-private-value' };
  const second = await f.coordinator.observe(secondCandidate, source);
  const secondId = 'id' in second ? second.id : '';
  expect(await f.coordinator.contentStatus(source, secondId)).toEqual({ status: 'dismissed' });
  expect(await f.coordinator.contentStatus(source)).toEqual(first);
  expect(await f.coordinator.observe(secondCandidate, source)).toEqual({ status: 'muted' });
  expect(await f.coordinator.review()).toMatchObject({ status: 'review', id: 'id' in first ? first.id : '' });
  expect(f.writes()).toBe(0); f.coordinator.clear();
});

it('enriches one source-local PAN before review, freezes review, and retains original expiry', async () => {
  const f = fixture();
  const card = { kind: 'card', cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '', scopeId: 'a'.repeat(32) } as const;
  const first = await f.coordinator.observe(card, source);
  f.setNow(60_000);
  const complete = { ...card, cardholderName: 'Synthetic Cardholder', expiryMonth: '12', expiryYear: '2031' };
  expect(await f.coordinator.observe(complete, source)).toEqual(first);
  expect(await f.coordinator.beginReview('id' in first ? first.id : '')).toMatchObject({ status: 'review', candidate: complete });
  expect(await f.coordinator.observe({ ...complete, cardholderName: 'Changed after review' }, source)).toEqual(first);
  expect(await f.coordinator.review()).toMatchObject({ status: 'review', candidate: complete });
  await f.coordinator.dismiss('id' in first ? first.id : '');
  expect(await f.coordinator.observe(complete, source)).toEqual({ status: 'muted' });
  expect(await f.coordinator.review()).toEqual({ status: 'empty' });
  f.setNow(180_002);
  expect(await f.coordinator.observe(complete, source)).toMatchObject({ status: 'accepted' });
  f.coordinator.clear();
});

it('keeps equal PANs in distinct groups, changed PANs, and different documents separate', async () => {
  const f = fixture();
  const card = { kind: 'card', cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '', scopeId: 'a'.repeat(32) } as const;
  const observations = [await f.coordinator.observe(card, source),
    await f.coordinator.observe({ ...card, scopeId: 'b'.repeat(32) }, source),
    await f.coordinator.observe({ ...card, cardNumber: '5555555555554444' }, source),
    await f.coordinator.observe(card, { ...source, browserDocumentId: 'other' })];
  expect(new Set(observations.map(result => 'id' in result ? result.id : '')) .size).toBe(4);
  f.coordinator.clear();
});

it('does not freeze PAN enrichment on automatic preview reads before explicit selection', async () => {
  const f = fixture();
  const card = { kind: 'card', cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '', scopeId: 'a'.repeat(32) } as const;
  const first = await f.coordinator.observe(card, source);
  expect(await f.coordinator.review()).toMatchObject({ status: 'review', candidate: card });
  const complete = { ...card, cardholderName: 'Synthetic Holder', expiryMonth: '11', expiryYear: '2032' };
  await f.coordinator.observe(complete, source);
  expect(await f.coordinator.review()).toMatchObject({ status: 'review', candidate: complete });
  expect('id' in first).toBe(true); f.coordinator.clear();
});

it('selects only the addressed current candidate and leaves other previews enrichable', async () => {
  const f = fixture();
  const card = { kind: 'card', cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '', scopeId: 'a'.repeat(32) } as const;
  const first = await f.coordinator.observe(card, source);
  const second = await f.coordinator.observe({ ...card, scopeId: 'b'.repeat(32), cardholderName: 'Second form' }, source);
  expect(await f.coordinator.beginReview('missing')).toEqual({ status: 'empty' });
  expect(await f.coordinator.beginReview('id' in second ? second.id : '')).toMatchObject({ status: 'review', candidate: { cardholderName: 'Second form' } });
  const enriched = { ...card, cardholderName: 'First completed' };
  expect(await f.coordinator.observe(enriched, source)).toEqual(first);
  expect(await f.coordinator.review()).toMatchObject({ status: 'review', candidate: enriched });
  f.coordinator.clear();
});
