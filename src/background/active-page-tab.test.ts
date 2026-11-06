import { afterEach, expect, it, vi } from 'vitest';
import { activePageTab } from './active-page-tab';
afterEach(() => vi.unstubAllGlobals());
it('selects the active page in the last normal window when the extension popup has no tabs', async () => {
  const query = vi.fn(async (options: { windowId?: number }) => options.windowId === 7 ? [{ id: 12, windowId: 7 }] : []);
  const getLastFocused = vi.fn(async () => ({ id: 7, type: 'normal' }));
  vi.stubGlobal('chrome', { tabs: { query }, windows: { getLastFocused } });
  expect(await activePageTab()).toMatchObject({ id: 12 });
  expect(getLastFocused).toHaveBeenCalledWith({ windowTypes: ['normal'] });
  expect(query).toHaveBeenCalledWith({ active: true, windowId: 7 });
});
it('rejects a normal-window switch during the lookup', async () => {
  const getLastFocused = vi.fn().mockResolvedValueOnce({ id: 7 }).mockResolvedValueOnce({ id: 8 });
  vi.stubGlobal('chrome', { tabs: { query: async () => [{ id: 12, windowId: 7 }] }, windows: { getLastFocused } });
  expect(await activePageTab()).toBeNull();
});
it('fails closed without an eligible normal window or on browser API failure', async () => {
  vi.stubGlobal('chrome', { windows: { getLastFocused: async () => { throw Error('no window'); } } });
  expect(await activePageTab()).toBeNull();
});
