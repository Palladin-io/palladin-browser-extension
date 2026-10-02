import { describe, expect, it, vi } from 'vitest';
import { ShareSaveCoordinator, type ShareSaveDeps, type ShareSource } from './coordinator';
import type { ShareSnapshot } from '../../shared/messaging/share-save';

const source: ShareSource = { tabId: 7, documentId: 'browser-document',
  url: 'https://stage.palladin.io/share/11111111-1111-4111-8111-111111111111',
  webOrigin: 'https://stage.palladin.io', apiUrl: 'https://api.stage.palladin.io' };
const snapshot: ShareSnapshot = { schema: 'palladin.entry-share.v1', title: 'Synthetic login',
  entryType: 'credential', fields: [
    { id: 'credential.username', label: '', type: 'text', value: '' },
    { id: 'credential.password', label: '', type: 'concealed', value: 'synthetic' },
  ] };
const vaultId = '22222222-2222-4222-8222-222222222222';

function setup(vaults: readonly { id: string; name: string }[] = [{ id: vaultId, name: 'Personal' }]) {
  const keys = {};
  const state = { now: 1_000, keys: keys as object | null, current: true, userId: 'member',
    apiUrl: source.apiUrl };
  const save = vi.fn(async (_snapshot: ShareSnapshot, _vaultId: string, assertCurrent: () => Promise<void>) => {
    await assertCurrent(); return true;
  });
  const onExpired = vi.fn();
  const deps: ShareSaveDeps = { now: () => state.now, keys: () => state.keys,
    userId: async () => state.userId, apiUrl: () => state.apiUrl,
    currentSource: async () => state.current, onExpired, vaults: async () => vaults,
    canManage: async () => true, save };
  return { coordinator: new ShareSaveCoordinator(deps), state, save, onExpired };
}

describe('extension-owned share confirmation', () => {
  it('saves only after popup confirmation to an existing destination Vault', async () => {
    const { coordinator, save } = setup();
    expect(await coordinator.prepare(source, snapshot)).toBe('pending');
    const pending = await coordinator.view();
    expect(pending).toMatchObject({ title: 'Synthetic login', vaults: [{ id: vaultId, name: 'Personal' }] });
    expect(save).not.toHaveBeenCalled();
    expect(await coordinator.confirm(pending!.id, vaultId)).toBe('saved');
    expect(save).toHaveBeenCalledOnce();
    expect(await coordinator.view()).toBeNull();
  });

  it('rejects a changed browser document, session, API or expired handoff', async () => {
    const scenarios = [
      (state: ReturnType<typeof setup>['state']) => { state.current = false; },
      (state: ReturnType<typeof setup>['state']) => { state.keys = {}; },
      (state: ReturnType<typeof setup>['state']) => { state.apiUrl = 'https://api.palladin.io'; },
      (state: ReturnType<typeof setup>['state']) => { state.now += 120_001; },
    ];
    for (const change of scenarios) {
      const { coordinator, state, save } = setup();
      expect(await coordinator.prepare(source, snapshot)).toBe('pending');
      const pending = await coordinator.view();
      change(state);
      expect(await coordinator.confirm(pending!.id, vaultId)).toBe('failed');
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('clears pending plaintext on cancel and tab navigation', async () => {
    const { coordinator } = setup();
    await coordinator.prepare(source, snapshot);
    const pending = await coordinator.view();
    coordinator.cancel(pending!.id);
    expect(await coordinator.view()).toBeNull();
    await coordinator.prepare(source, snapshot);
    expect(coordinator.clearTab(source.tabId)).toBe(true);
    expect(await coordinator.view()).toBeNull();
  });
  it('reconciles only the same browser document and handoff after cancellation or save', async () => {
    const { coordinator } = setup();
    const cancelledId = '11111111-1111-4111-8111-111111111112';
    await coordinator.prepare(source, snapshot, cancelledId);
    expect(await coordinator.reconcile(source, cancelledId)).toBe('pending');
    const pending = await coordinator.view();
    coordinator.cancel(pending!.id);
    expect(await coordinator.reconcile(source, cancelledId)).toBe('cancelled');
    expect(await coordinator.reconcile(source, 'other-request')).toBe('unknown');
    expect(await coordinator.reconcile({ ...source, documentId: 'other-document' }, cancelledId)).toBe('unknown');
    const savedId = '11111111-1111-4111-8111-111111111113';
    await coordinator.prepare(source, snapshot, savedId);
    const next = await coordinator.view();
    expect(await coordinator.confirm(next!.id, vaultId)).toBe('saved');
    expect(await coordinator.reconcile(source, savedId)).toBe('saved');
    expect(await coordinator.reconcile(source, cancelledId)).toBe('unknown');
  });

  it('clears only the replaced document and notifies when a pending handoff expires', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, onExpired } = setup();
      await coordinator.prepare(source, snapshot);
      expect(coordinator.clearDocument(source.tabId, 'different-document')).toBe(false);
      expect(coordinator.clearReplacedDocument(source.tabId, 'new-document')).toBe(true);
      expect(await coordinator.view()).toBeNull();
      await coordinator.prepare(source, snapshot);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await coordinator.view()).toBeNull();
      expect(onExpired).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('keeps the old confirmation when a replacement is rejected', async () => {
    const { coordinator } = setup();
    await coordinator.prepare(source, snapshot);
    const original = await coordinator.view();
    const rejected = { ...snapshot, entryType: 'key' as const, fields: [
      { id: 'key.value', label: '', type: 'concealed' as const, value: 'synthetic' },
      { id: 'key.url', label: '', type: 'text' as const, value: 'https://example.test' },
    ] };
    expect(await coordinator.prepare(source, rejected)).toBe('unavailable');
    expect(await coordinator.view()).toEqual(original);
  });

  it('notifies open surfaces if view observes expiry before its timer fires', async () => {
    const { coordinator, state, onExpired } = setup();
    await coordinator.prepare(source, snapshot);
    state.now += 120_001;
    expect(await coordinator.view()).toBeNull();
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it('does not retain a snapshot when no destination Vault is available', async () => {
    const { coordinator, save } = setup([]);
    expect(await coordinator.prepare(source, snapshot)).toBe('unavailable');
    expect(await coordinator.view()).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
