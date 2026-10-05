vi.mock('../../shared/config/build-target', () => ({ extensionBuildTarget: 'firefox' }));
import { describe, expect, it, vi } from 'vitest';
import { handleConnectionCommand, isConnectionCommand, saveConnectionSharingPreference } from './connection-commands';
import { ServerConfigStore } from './server-config-store';
import type { Connection } from '../../shared/config/connection';
const connection: Connection = { name: 'Own', apiUrl: 'https://api.example.test', webUrl: 'https://panel.example.test', sharedUnlockEnabled: true, allowHttp: false };
function fixture() {
  const data: Record<string, unknown> = {};
  return { store: new ServerConfigStore({ get: async () => data, set: async values => { Object.assign(data, values); }, remove: async () => {} }, connection.apiUrl), retire: vi.fn(async () => {}), preference: vi.fn(async (_enabled: boolean) => {}), access: vi.fn(async () => true) };
}
describe('connection mutation boundary', () => {
  it('refuses a permission denial without changing the session or active pair', async () => {
    const f = fixture(); await f.store.saveConnection(connection); f.access.mockResolvedValue(false);
    expect(await handleConnectionCommand(f.store, { type: 'config/connections/save', connection: { ...connection, apiUrl: 'https://other.example.test' } }, f.access, f.retire, f.preference)).toEqual({ ok: false, code: 'unavailable' });
    expect(f.store.activeConnection).toEqual(connection); expect(f.retire).not.toHaveBeenCalled();
  });
  it('retains own sessions when switching sharing OFF and ON', async () => {
    const f = fixture(); await f.store.saveConnection(connection);
    for (const enabled of [false, true]) {
      await handleConnectionCommand(f.store, { type: 'config/connections/save', connection: { ...connection, sharedUnlockEnabled: enabled } }, f.access, f.retire, f.preference);
      expect(f.store.sharedUnlockEnvironments).toHaveLength(enabled ? 1 : 0);
    }
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.preference.mock.calls.map(call => call[0])).toEqual([false, true]);
  });
  it('retires the previous session before publishing a different panel on the same API', async () => {
    const f = fixture(); await f.store.saveConnection(connection);
    f.retire.mockImplementation(async () => { expect(f.store.activeConnection).toEqual(connection); });
    await handleConnectionCommand(f.store, { type: 'config/connections/save', connection: { ...connection, webUrl: 'https://other.example.test' } }, f.access, f.retire, f.preference);
    expect(f.retire).toHaveBeenCalledOnce(); expect(f.store.activeConnection?.webUrl).toBe('https://other.example.test');
  });
  it('does not report sharing disabled when the account preference could not be saved', async () => {
    const f = fixture(); await f.store.saveConnection(connection);
    f.preference.mockRejectedValue(new Error('Preference unavailable'));
    await expect(handleConnectionCommand(f.store, { type: 'config/connections/save',
      connection: { ...connection, sharedUnlockEnabled: false } }, f.access, f.retire, f.preference)).rejects.toThrow('Preference unavailable');
    expect(f.store.activeConnection).toEqual(connection);
    expect(f.retire).not.toHaveBeenCalled();
  });
  it.each(['locked', 'unlocked', 'signed-out'] as const)('does not confuse %s with a saved account preference', async status => {
    const f = fixture(); await f.store.saveConnection(connection);
    const dispatch = vi.fn(async () => ({ ok: false as const, code: 'authentication-required' as const, locallyPaused: false }));
    const save = handleConnectionCommand(f.store, { type: 'config/connections/save',
      connection: { ...connection, sharedUnlockEnabled: false } }, f.access, f.retire,
      enabled => saveConnectionSharingPreference(enabled, dispatch, async () => status));
    if (status === 'signed-out') {
      await expect(save).resolves.toMatchObject({ ok: true });
      expect(f.store.activeConnection?.sharedUnlockEnabled).toBe(false);
    } else {
      await expect(save).rejects.toThrow('preference unavailable');
      expect(f.store.activeConnection).toEqual(connection);
    }
    expect(f.retire).not.toHaveBeenCalled();
  });
  it('never activates an unknown profile or accepts plaintext/session fields in configuration', async () => {
    const f = fixture();
    expect(await handleConnectionCommand(f.store, { type: 'config/connections/activate', apiUrl: connection.apiUrl }, f.access, f.retire, f.preference)).toEqual({ ok: false, code: 'invalid-server' });
    expect(isConnectionCommand({ type: 'config/connections/save', connection: { ...connection, accessToken: 'not-a-real-token' } })).toBe(false);
    expect(isConnectionCommand({ type: 'config/connections/save', connection: { ...connection, apiUrl: 'http://api.example.test' } })).toBe(false);
  });
  it('removes an old panel grant but retains hosts referenced by other saved pairs', async () => {
    const f = fixture(); const remove = vi.fn(async () => true);
    await f.store.saveConnection({ ...connection, apiUrl: 'https://retained.example.test', webUrl: 'https://retained-panel.example.test' });
    await f.store.saveConnection(connection);
    await handleConnectionCommand(f.store, { type: 'config/connections/save', connection: { ...connection, webUrl: 'https://new.example.test' } }, f.access, f.retire, f.preference, remove);
    expect(remove).toHaveBeenCalledExactlyOnceWith(['https://panel.example.test/*']);
  });
  it('cleans an attempted unused grant after persistence fails without removing the current pair', async () => {
    const f = fixture(); const remove = vi.fn(async () => true);
    await f.store.saveConnection(connection);
    vi.spyOn(f.store, 'saveConnection').mockRejectedValue(new Error('Storage unavailable'));
    await expect(handleConnectionCommand(f.store, { type: 'config/connections/save', connection: { ...connection, webUrl: 'https://new.example.test' } }, f.access, f.retire, f.preference, remove)).rejects.toThrow('Storage unavailable');
    expect(remove).toHaveBeenCalledExactlyOnceWith(['https://new.example.test/*']);
    expect(f.store.activeConnection).toEqual(connection);
  });
  it('retains a panel hostname still used at another port', async () => {
    const f = fixture(); const remove = vi.fn(async () => true);
    await f.store.saveConnection({ ...connection, apiUrl: 'https://retained.example.test', webUrl: connection.webUrl + ':8443' });
    await f.store.saveConnection(connection);
    await handleConnectionCommand(f.store, { type: 'config/connections/save', connection: { ...connection, webUrl: 'https://new.example.test' } }, f.access, f.retire, f.preference, remove);
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the replaced panel of an inactive saved configuration', async () => {
    const f = fixture(); const remove = vi.fn(async () => true);
    await f.store.saveConnection(connection);
    await f.store.saveConnection({ ...connection, apiUrl: 'https://other-api.example.test', webUrl: 'https://other-panel.example.test' });
    await handleConnectionCommand(f.store, { type: 'config/connections/save', connection: { ...connection, webUrl: 'https://new.example.test' } }, f.access, f.retire, f.preference, remove);
    expect(remove).toHaveBeenCalledExactlyOnceWith(['https://panel.example.test/*']);
  });

});
