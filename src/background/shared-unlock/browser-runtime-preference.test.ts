import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { coordinateSharedUnlockBrowser } from './browser-runtime'
import type { ChromiumSharedUnlockRoute } from './chromium-route'
import type { SharedUnlockCoordinatorRoute } from './browser-coordinator'
import type { SharedUnlockOperationMessage } from '../../shared/messaging/shared-unlock-operation'
import { sharedUnlockPreferences } from './preference-state-runtime'
import { sessionManager } from '../session/runtime'

vi.mock('../config/server-runtime', () => ({ serverConfig: { apiUrl: 'https://api.test' } }))
vi.mock('../session/runtime', () => ({
  sessionManager: {
    hooks: { onLocked: vi.fn(() => () => {}), onUnlocked: vi.fn(() => () => {}) },
    getUserId: async () => '11111111-1111-4111-8111-111111111111', getStatus: async () => 'locked',
    captureSharedUnlockSettingsSession: vi.fn(), captureSharedUnlockSource: vi.fn(), lock: vi.fn(), logout: vi.fn(),
  },
  sharedUnlockSource: { snapshot: () => ({ authorization: null, preference: null, sourceGeneration: null }),
    closingWitness: () => null, subscribe: () => () => {} },
  sharedUnlockLinks: {}, sharedUnlockExpiry: {}, sharedUnlockPreferenceGate: { subscribe: () => () => {} },
}))
const scope = { apiUrl: 'https://api.test', accountId: '11111111-1111-4111-8111-111111111111' }
const cleanup: (() => void)[] = []
function start() {
  const abort = new AbortController(), listeners = new Set<(message: SharedUnlockOperationMessage) => void>()
  const sent: SharedUnlockOperationMessage[] = []
  const route: SharedUnlockCoordinatorRoute = { ...scope, webOrigin: 'https://web.test', extensionId: 'a'.repeat(32),
    documentBinding: 'browser-owned-document', signal: abort.signal, close: () => abort.abort(),
    assertCurrent: () => { if (abort.signal.aborted) throw new Error('retired') }, verifyCurrent: async () => { route.assertCurrent() },
    sendOperation: message => { sent.push(message) },
    onOperation: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const runtime = coordinateSharedUnlockBrowser(route as ChromiumSharedUnlockRoute)
  cleanup.push(() => { runtime.close(); route.close(); expect(listeners.size).toBe(0) })
  return { sent }
}
beforeEach(() => { vi.clearAllMocks(); sharedUnlockPreferences.clear() })
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllGlobals(); sharedUnlockPreferences.clear() })

it('connects locked worker preference repair to its token-only lease without borrowing keys or closing its own session', async () => {
  const abort = new AbortController(), dispose = vi.fn(() => abort.abort())
  vi.mocked(sessionManager.captureSharedUnlockSettingsSession).mockReturnValue({ signal: abort.signal, dispose,
    read: () => ({ apiUrl: scope.apiUrl, userId: scope.accountId, accessToken: 'own-worker-access', refreshToken: 'own-worker-refresh' }) })
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ sharedUnlockEnabled: false, revision: 2 })))
  vi.stubGlobal('fetch', fetcher)
  const f = start()
  await vi.waitFor(() => expect(sharedUnlockPreferences.isDisabled(scope)).toBe(true))
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(scope.apiUrl + '/api/account/shared-unlock', expect.objectContaining({
    method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer own-worker-access' }),
  }))
  expect(dispose).toHaveBeenCalledOnce()
  expect(sessionManager.captureSharedUnlockSource).not.toHaveBeenCalled()
  expect(sessionManager.lock).not.toHaveBeenCalled(); expect(sessionManager.logout).not.toHaveBeenCalled()
  expect(f.sent.some(message => message.payload.kind === 'preference-invalidated')).toBe(false)
})

it('disposes a captured settings lease when its first read loses the own lifecycle race', async () => {
  const dispose = vi.fn(), fetcher = vi.fn<typeof fetch>()
  vi.mocked(sessionManager.captureSharedUnlockSettingsSession).mockReturnValue({ signal: new AbortController().signal, dispose,
    read: () => { throw new Error('own lifecycle changed') } })
  vi.stubGlobal('fetch', fetcher)
  start()
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  expect(fetcher).not.toHaveBeenCalled(); expect(sharedUnlockPreferences.isDisabled(scope)).toBe(false)
})
