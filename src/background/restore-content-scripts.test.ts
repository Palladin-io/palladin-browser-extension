import { afterEach, expect, it, vi } from 'vitest';
import { restoreContentScripts } from './restore-content-scripts';

afterEach(() => vi.unstubAllGlobals());

it('restores only packaged isolated scripts in top frames and tolerates a closed or denied tab', async () => {
  const executeScript = vi.fn().mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue([]);
  const query = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }, {}]);
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ content_scripts: [
      { js: ['assets/isolated-loader.js'] },
      { world: 'MAIN', js: ['assets/main-loader.js'] },
    ] }) },
    tabs: { query }, scripting: { executeScript },
  });
  await expect(restoreContentScripts()).resolves.toBeUndefined();
  expect(query).toHaveBeenCalledWith({ url: ['https://*/*'] });
  expect(executeScript.mock.calls).toEqual([1, 2].map(tabId => [{
    target: { tabId, frameIds: [0] }, world: 'ISOLATED', files: ['assets/isolated-loader.js'],
  }]));
});
