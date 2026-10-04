import { describe, expect, it } from 'vitest';
import { ServerConfigStore, CONNECTIONS_CONFIG_KEY } from './server-config-store';
import type { Connection } from '../../shared/config/connection';

const connection: Connection = { name: 'Own server', apiUrl: 'https://api.example.test', webUrl: 'https://panel.example.test/app', sharedUnlockEnabled: true, allowHttp: false };
function fixture() {
  const data: Record<string, unknown> = {};
  const store = new ServerConfigStore({ get: async () => data, set: async values => { Object.assign(data, values); }, remove: async () => {} }, 'https://default.example.test');
  return { store, data };
}
describe('trusted connection configuration', () => {
  it('does not infer a trusted panel from a saved API', async () => {
    const f = fixture(); await f.store.initialize();
    expect(f.store.sharedUnlockEnvironments).toEqual([]);
  });
  it('does not grandfather HTTP access from a legacy API-only setting', async () => {
    const store = new ServerConfigStore({ get: async () => ({}), set: async () => {}, remove: async () => {} }, 'http://localhost:5000');
    expect(store.apiUrl).toBe('http://localhost:5000');
    expect(() => store.networkApiUrl).toThrow('HTTP requires consent');
    await store.saveConnection({ ...connection, apiUrl: 'http://localhost:5000', allowHttp: true });
    expect(store.networkApiUrl).toBe('http://localhost:5000');
  });
  it('keeps multiple public configurations but admits only the active pair', async () => {
    const f = fixture(); await f.store.saveConnection(connection);
    const second = { ...connection, apiUrl: 'https://other.example.test', webUrl: 'https://other-panel.example.test' };
    await f.store.saveConnection(second);
    expect(f.store.connections.connections).toHaveLength(2);
    expect(f.store.sharedUnlockEnvironments).toEqual([{ apiUrl: second.apiUrl, webOrigin: second.webUrl }]);
    await f.store.activateConnection(connection.apiUrl);
    expect(f.store.apiUrl).toBe(connection.apiUrl);
    expect(f.store.sharedUnlockEnvironments).toEqual([{ apiUrl: connection.apiUrl, webOrigin: 'https://panel.example.test' }]);
  });
  it('requires explicit HTTP consent, including localhost and LAN', async () => {
    const f = fixture();
    for (const host of ['localhost:5000', '127.0.0.1:5000', '[::1]:5000', '192.168.1.5:5000']) {
      const http = { ...connection, apiUrl: `http://${host}` };
      await expect(f.store.saveConnection(http)).rejects.toThrow();
      await f.store.saveConnection({ ...http, allowHttp: true });
      expect(f.store.apiUrl).toBe(http.apiUrl);
    }
  });
  it('OFF removes admission without deleting the configuration', async () => {
    const f = fixture(); await f.store.saveConnection(connection);
    await f.store.saveConnection({ ...connection, sharedUnlockEnabled: false });
    expect(f.store.sharedUnlockEnvironments).toEqual([]);
    expect(f.store.connections.connections).toHaveLength(1);
  });
  it('fails closed on corrupted or duplicate durable connection metadata', async () => {
    const f = fixture();
    f.data[CONNECTIONS_CONFIG_KEY] = { connections: [connection, connection], activeApiUrl: connection.apiUrl };
    await f.store.initialize();
    expect(f.store.sharedUnlockEnvironments).toEqual([]);
  });
});
