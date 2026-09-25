import { afterEach, describe, expect, it, vi } from 'vitest';
import { vaultCommandDeps } from './runtime';
import { generatorHistory } from '../generator/runtime';
import { sessionManager } from '../session/runtime';
import { registerTopFrameDocument } from '../tab-documents';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('popup generator fill runtime boundary', () => {
  it('does not send a generated value after the active tab changes during history persistence', async () => {
    const url = 'https://accounts.example.com/register';
    const documentId = '0123456789abcdef0123456789abcdef';
    const browserDocumentId = 'browser-document-1';
    const releaseFirst = registerTopFrameDocument({ sender: {
      id: 'extension-id', frameId: 0, tab: { id: 7 }, documentId: browserDocumentId,
    } } as chrome.runtime.Port, 'extension-id');
    const releaseSecond = registerTopFrameDocument({ sender: {
      id: 'extension-id', frameId: 0, tab: { id: 8 }, documentId: 'browser-document-2',
    } } as chrome.runtime.Port, 'extension-id');
    let activeTab = 7;
    const sendMessage = vi.fn(async (_tabId: number, message: { channel: string }) => {
      if (message.channel === 'palladin.tab/current-url') return { url, documentId };
      return { ok: true };
    });
    vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => [{ id: activeTab }]), sendMessage } });
    const keys = { privateKey: new Uint8Array(32) };
    vi.spyOn(sessionManager, 'getKeys').mockReturnValue(keys as ReturnType<typeof sessionManager.getKeys>);
    vi.spyOn(generatorHistory, 'remember').mockImplementation(async () => { activeTab = 8; });
    try {
      const result = await vaultCommandDeps.sendFill({ id: 7, url, documentId, browserDocumentId }, null,
        [{ kind: 'generated', value: 'synthetic-strong-password' }], false);
      expect(result).toEqual({ ok: false, reason: 'target-changed' });
      expect(sendMessage.mock.calls.filter(([, message]) => message.channel === 'palladin.fill/request')).toEqual([]);
    } finally { releaseFirst?.(); releaseSecond?.(); }
  });
});
