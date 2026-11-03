import { describe, expect, it, vi } from 'vitest';
import { TotpCaptureCoordinator } from './totp-coordinator';
const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example';
const source = { tabId: 1, frameId: 0, browserDocumentId: 'browser', topDocumentId: 'browser', documentId: 'document', url: 'https://example.com/setup' };
const target = { action: 'update' as const, vaultId: 'vault', entryId: 'entry', revision: '4', label: 'Alice', vaultLabel: 'Personal', hasTotp: true };
function fixture() {
  let generation = 1, live = true, time = 0;
  const save = vi.fn(async () => ({ action: 'updated' as const, revision: '5' }));
  const coordinator = new TotpCaptureCoordinator({ session: async () => ({ profileId: 'user', generation, unlocked: true }),
    current: async () => live, activeTabId: async () => 1, choices: async () => [target], save,
    now: () => time, createId: () => crypto.randomUUID() });
  return { coordinator, save, expire: () => { time = 180_000; }, lock: () => { generation++; }, navigate: () => { live = false; } };
}
describe('TOTP candidate authority', () => {
  it('returns safe review and requires explicit replacement confirmation', async () => {
    const f = fixture(); expect(await f.coordinator.observe(uri, source)).toMatchObject({ status: 'accepted' });
    const review = await f.coordinator.review();
    expect(JSON.stringify(review)).not.toContain('JBSWY3DPEHPK3PXP');
    if (review.status !== 'ready') throw Error('missing review');
    expect(review.defaultTargetId).toBe(review.targets[0]!.id);
    expect(await f.coordinator.save(review.id, review.targets[0]!.id, false)).toEqual({ status: 'confirmation-required' });
    expect(f.save).not.toHaveBeenCalled();
    expect(await f.coordinator.save(review.id, review.targets[0]!.id, true)).toEqual({ status: 'saved' });
  });
  it.each(['expire', 'lock', 'navigate'] as const)('rejects stale candidates after %s', async change => {
    const f = fixture(); await f.coordinator.observe(uri, source); const review = await f.coordinator.review();
    if (review.status !== 'ready') throw Error('missing review'); f[change]();
    expect(await f.coordinator.save(review.id, review.targets[0]!.id, true)).toEqual({ status: 'stale' });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('requires a choice among multiple exact-host Credentials and exposes creation for an empty match', async () => {
    const session = async () => ({ profileId: 'user', generation: 1, unlocked: true });
    const create = { action: 'create' as const, vaultId: 'vault', label: 'Personal', vaultLabel: 'Personal' };
    for (const targets of [[create, target, { ...target, entryId: 'other' }], [create]]) {
      const c = new TotpCaptureCoordinator({ session, current: async () => true, activeTabId: async () => 1,
        choices: async () => targets, save: async () => ({}) });
      await c.observe(uri, source); const review = await c.review();
      expect(review.status).toBe('ready'); if (review.status !== 'ready') throw Error('missing review');
      expect(review.defaultTargetId).toBeNull();
      expect(review.targets.filter(item => item.action === 'update')).toHaveLength(targets.length - 1);
      c.clear();
    }
  });
  it('does not expose the seed even when an untrusted issuer embeds it', async () => {
    const f = fixture(); await f.coordinator.observe(uri.replace('issuer=Example', 'issuer=JBSWY3DPEHPK3PXP'), source);
    expect(JSON.stringify(await f.coordinator.review())).not.toContain('JBSWY3DPEHPK3PXP');
  });
  it('invalidates a reviewed candidate when the page rotates its setup', async () => {
    const f = fixture(); await f.coordinator.observe(uri, source); const review = await f.coordinator.review();
    if (review.status !== 'ready') throw Error('missing review');
    await f.coordinator.observe(uri.replace('JBSWY3DPEHPK3PXP', 'KRSXG5DSNFXGOIDB'), source);
    expect(await f.coordinator.save(review.id, review.targets[0]!.id, true)).toEqual({ status: 'stale' });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('discards an observation whose initiating session changed while awaiting source validation', async () => {
    let release!: (live: boolean) => void; let generation = 1;
    const coordinator = new TotpCaptureCoordinator({ session: async () => ({ profileId: 'user', generation, unlocked: true }),
      current: () => new Promise(resolve => { release = resolve; }), activeTabId: async () => 1,
      choices: async () => [target], save: async () => ({}) });
    const pending = coordinator.observe(uri, source, () => generation === 1);
    await vi.waitFor(() => expect(release).toBeDefined()); generation = 3; release(true);
    expect(await pending).toEqual({ status: 'stale' });
  });
  it('does not admit a delayed observation from an earlier session', async () => {
    let release!: (session: { profileId: string; generation: number; unlocked: boolean }) => void; let generation = 1;
    let calls = 0;
    const coordinator = new TotpCaptureCoordinator({ session: () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ profileId: 'user', generation, unlocked: true }),
      current: async () => true, activeTabId: async () => 1, choices: async () => [target], save: async () => ({}) });
    const pending = coordinator.observe(uri, source, () => generation === 1);
    generation = 3; release({ profileId: 'user', generation, unlocked: true });
    expect(await pending).toEqual({ status: 'stale' });
  });
  it('does not start a second concurrent save', async () => {
    const f = fixture(); let finish!: (result: { action: 'updated'; revision: string }) => void;
    f.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.coordinator.observe(uri, source); const review = await f.coordinator.review();
    if (review.status !== 'ready') throw Error('missing review');
    const first = f.coordinator.save(review.id, review.targets[0]!.id, true);
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1));
    expect(await f.coordinator.save(review.id, review.targets[0]!.id, true)).toEqual({ status: 'stale' });
    finish({ action: 'updated', revision: '5' }); await first;
  });
  it('rejects subframes and non-TOTP payloads', async () => {
    const f = fixture(); expect(await f.coordinator.observe(uri, { ...source, frameId: 1 })).toEqual({ status: 'stale' });
    expect(await f.coordinator.observe('123456', source)).toEqual({ status: 'invalid' });
  });
});
it('invalidates an open native view when the fixed candidate lifetime expires', async () => {
  vi.useFakeTimers(); const invalidated = vi.fn();
  try {
    const c = new TotpCaptureCoordinator({ session: async () => ({ profileId: 'user', generation: 1, unlocked: true }),
      current: async () => true, activeTabId: async () => 1, choices: async () => [target], save: async () => ({}), invalidated });
    await c.observe(uri, source); await vi.advanceTimersByTimeAsync(180_000);
    expect(invalidated).toHaveBeenCalledOnce(); expect(await c.review()).toEqual({ status: 'empty' });
  } finally { vi.useRealTimers(); }
});
