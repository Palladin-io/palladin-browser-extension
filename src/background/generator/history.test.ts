import { describe, expect, it, vi } from 'vitest';
import { GeneratorHistory, GeneratorHistoryError, GENERATOR_HISTORY_CAPACITY, type HistorySession } from './history';

function setup() {
  const data: Record<string, unknown> = {};
  let generation = 0;
  let accountId = '00000000-0000-4000-8000-000000000001';
  const storage = {
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]))),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, values); }),
    remove: vi.fn(async (keys: string[]) => { keys.forEach(key => { delete data[key]; }); }),
  };
  const session = async (): Promise<HistorySession> => {
    const captured = generation;
    return { accountId, apiUrl: 'https://api.example.test', privateKey: new Uint8Array(32).fill(7),
      assertCurrent: () => { if (captured !== generation) throw new GeneratorHistoryError('locked'); } };
  };
  return { data, storage, history: new GeneratorHistory(storage, session),
    restart: () => new GeneratorHistory(storage, session),
    lock: () => { generation++; },
    switchAccount: () => { generation++; accountId = '00000000-0000-4000-8000-000000000002'; } };
}

describe('generator history', () => {
  it('refuses new passwords when full without evicting recoverable values', async () => {
    const { history } = setup();
    for (let index = 0; index < GENERATOR_HISTORY_CAPACITY; index++) {
      await history.remember(`synthetic-password-${index}`, null);
    }
    await expect(history.remember('synthetic-over-capacity', null)).rejects.toMatchObject({ code: 'full' });
    const items = await history.list();
    expect(items).toHaveLength(GENERATOR_HISTORY_CAPACITY);
    expect(await history.reveal(items.at(-1)!.id)).toBe('synthetic-password-0');
  });

  it('rejects ciphertext moved into another account namespace', async () => {
    const { history, data, switchAccount } = setup();
    await history.remember('synthetic-password-A', null);
    const [key] = Object.keys(data);
    data[key!.replace(/1$/, '2')] = data[key!];
    switchAccount();
    await expect(history.list()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('keeps only ciphertext durably and reveals on demand after worker restart', async () => {
    const { history, restart, data } = setup();
    await history.remember('synthetic-password-A', 'https://shop.example.test');
    const json = JSON.stringify(data);
    expect(json).not.toContain('synthetic-password-A');
    expect(json).not.toContain('shop.example.test');
    const fresh = restart();
    const [item] = await fresh.list();
    expect(item).toMatchObject({ origin: 'https://shop.example.test' });
    expect(item).not.toHaveProperty('value');
    expect(await fresh.reveal(item!.id)).toBe('synthetic-password-A');
  });

  it('serializes concurrent writes without losing either recovery copy', async () => {
    const { history } = setup();
    await Promise.all([history.remember('synthetic-password-A', null), history.remember('synthetic-password-B', null)]);
    expect(await history.list()).toHaveLength(2);
    await history.remember('synthetic-password-A', null);
    expect(await history.list()).toHaveLength(2);
  });

  it('deletes explicitly and does not expose another account history', async () => {
    const { history, switchAccount } = setup();
    await history.remember('synthetic-password-A', null);
    const [item] = await history.list();
    await history.remove(item!.id);
    expect(await history.list()).toEqual([]);
    await history.remember('synthetic-password-B', null);
    switchAccount();
    expect(await history.list()).toEqual([]);
    await expect(history.reveal(item!.id)).rejects.toThrow();
  });

  it('rejects a failed durable write and preserves existing recovery data', async () => {
    const { history, storage } = setup();
    await history.remember('synthetic-password-A', null);
    storage.set.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(history.remember('synthetic-password-B', null)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await history.list()).toHaveLength(1);
  });

  it('does not release plaintext after a lock during durable read', async () => {
    const { history, storage, lock } = setup();
    await history.remember('synthetic-password-A', null);
    const [item] = await history.list();
    const read = storage.get.getMockImplementation()!;
    storage.get.mockImplementationOnce(async keys => { const data = await read(keys); lock(); return data; });
    await expect(history.reveal(item!.id)).rejects.toMatchObject({ code: 'locked' });
  });

  it('does not erase or overwrite corrupt history when adding a new password', async () => {
    const { history, data, storage } = setup();
    await history.remember('synthetic-password-A', null);
    const key = Object.keys(data)[0]!;
    data[key] = { version: 2, ciphertext: 'invalid' };
    await expect(history.remember('synthetic-password-B', null)).rejects.toThrow();
    expect(storage.set).toHaveBeenCalledTimes(1);
    await history.clear();
    expect(await history.list()).toEqual([]);
  });
});
