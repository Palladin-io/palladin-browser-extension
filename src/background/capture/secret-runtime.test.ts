import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../session/auth-client';
import { AutoLock } from '../session/auto-lock';
import { SessionManager } from '../session/session-manager';
import { SessionStore } from '../session/session-store';
import { buildTestAccount, FakeAlarms, FakeStorageArea, mockBackend } from '../session/test-support';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
describe('capture termination at the actual session boundary', () => {
  it.each(['lock','logout'] as const)('drops candidates and publishes editor invalidation before awaited manual %s closing', async action => {
    const account = await buildTestAccount(); const storage = new FakeStorageArea(); const alarms = new FakeAlarms();
    let release!: () => void; let started!: () => void;
    const closingStarted = new Promise<void>(resolve => { started = resolve; });
    const closing = new Promise<void>(resolve => { release = resolve; });
    const manager = new SessionManager({ store: new SessionStore(storage),
      authClient: new AuthClient(mockBackend(account).fetch, 'https://api.test'), autoLock: new AutoLock(alarms, () => {}),
      recordManualClosing: async () => { started(); await closing; },
    });
    await manager.login(account.email, account.password);
    const published: unknown[] = [];
    vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage: async (event: unknown) => { published.push(event); } },
      tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ url: 'https://example.test/', documentId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) } });
    vi.doMock('../session/runtime', () => ({ sessionManager: manager }));
    vi.doMock('../config/server-runtime', () => ({ initializeServerConfig: async () => {}, serverConfig: { apiUrl: 'https://api.test' } }));
    vi.doMock('../tab-documents', () => ({ browserDocumentIdForTab: () => 'top' }));
    vi.doMock('../vault/runtime', () => ({ vaultData: {} }));
    vi.doMock('./preferences-runtime', () => ({ capturePreferences: { isMuted: async () => false } }));
    const { secretCaptureCoordinator: coordinator, secretCaptureFrames: frames } = await import('./secret-runtime');
    const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, documentId: 'top', url: 'https://example.test/' } as chrome.runtime.MessageSender;
    frames.register(sender, 'extension'); const source = frames.source(sender, 'extension', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')!;
    vi.useFakeTimers();
    expect(await coordinator.observe({ kind: 'key', value: 'synthetic-private-value' }, source)).toMatchObject({ status: 'accepted' });
    expect(vi.getTimerCount()).toBe(1);
    let completed = false;
    const ending = manager[action]('manual').then(() => { completed = true; });
    await closingStarted;
    try {
      expect(manager.getKeys()).toBeNull(); expect(completed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(published).toContainEqual({ type: 'secret-capture/invalidated' });
      expect(await coordinator.review()).toEqual({ status: 'empty' });
    } finally { release(); await ending; coordinator.clear(); }
  });
});
