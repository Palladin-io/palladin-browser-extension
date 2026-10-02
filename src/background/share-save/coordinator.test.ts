import { describe, expect, it, vi } from 'vitest';
import { ShareSaveCoordinator, type ShareSaveDeps, type ShareSource } from './coordinator';
import type { ShareSnapshot } from '../../shared/messaging/share-save';

const source: ShareSource = { tabId: 7, documentId: 'browser-document',
  url: 'https://stage.palladin.io/share/11111111-1111-4111-8111-111111111111',
  webOrigin: 'https://stage.palladin.io', apiUrl: 'https://api.stage.palladin.io' };
const snapshot: ShareSnapshot = { schema: 'palladin.entry-share.v1', title: 'Synthetic login',
  entryType: 'credential', fields: [{ id: 'credential.password', label: '', type: 'concealed', value: 'synthetic' }] };
const vaultId = '22222222-2222-4222-8222-222222222222';

function setup() {
  const keys = {};
  const state = { now: 1_000, keys: keys as object | null, current: true, userId: 'member',
    apiUrl: source.apiUrl };
  const save = vi.fn(async (_snapshot: ShareSnapshot, _vaultId: string, assertCurrent: () => Promise<void>) => {
    await assertCurrent(); return true;
  });
  const deps: ShareSaveDeps = { now: () => state.now, keys: () => state.keys,
    userId: async () => state.userId, apiUrl: () => state.apiUrl,
    currentSource: async () => state.current, vaults: async () => [{ id: vaultId, name: 'Personal' }],
    canManage: async () => true, save };
  return { coordinator: new ShareSaveCoordinator(deps), state, save };
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
    coordinator.clearTab(source.tabId);
    expect(await coordinator.view()).toBeNull();
  });
});
