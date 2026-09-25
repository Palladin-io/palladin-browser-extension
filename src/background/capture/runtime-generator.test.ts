import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_DETECTED_CHANNEL } from '@shared/messaging/capture';
import { captureCoordinator } from './runtime';
import { generatorHistory } from '../generator/runtime';
import { sessionManager } from '../session/runtime';
import { registerTopFrameDocument } from '../tab-documents';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('generated fill runtime boundary', () => {
  it('does not release a persisted password after the user changes active tabs', async () => {
    const documentId = '0123456789abcdef0123456789abcdef';
    const browserDocumentId = 'browser-document-1';
    const url = 'https://accounts.example.com/register';
    const unregister = registerTopFrameDocument({ sender: {
      id: 'extension-id', frameId: 0, tab: { id: 7 }, documentId: browserDocumentId,
    } } as chrome.runtime.Port, 'extension-id');
    const unregisterOther = registerTopFrameDocument({ sender: {
      id: 'extension-id', frameId: 0, tab: { id: 8 }, documentId: 'browser-document-2',
    } } as chrome.runtime.Port, 'extension-id');
    expect(unregister).not.toBeNull();
    expect(unregisterOther).not.toBeNull();
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
      expect(captureCoordinator.observe({ channel: CAPTURE_DETECTED_CHANNEL, documentId,
        candidateId: 'candidate_0123456789abcdef', kind: 'registration' },
      { tabId: 7, url, browserDocumentId })).toBe(true);
      const prompt = await captureCoordinator.dispatch({ type: 'capture/prompt/get' });
      if (!prompt.ok || prompt.kind !== 'prompt' || !prompt.prompt) throw new Error('No prompt');
      const result = await captureCoordinator.dispatch({ type: 'capture/prompt/fill-generated',
        promptId: prompt.prompt.id, value: 'synthetic-strong-password' });
      expect(result).toMatchObject({ ok: true, kind: 'fill', fill: { status: 'no-form' } });
      expect(sendMessage.mock.calls.filter(([, message]) => message.channel === 'palladin.capture/fill')).toEqual([]);
    } finally { unregister?.(); unregisterOther?.(); }
  });
});
