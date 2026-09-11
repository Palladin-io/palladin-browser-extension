import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { coordinateSharedUnlockBrowser } from './browser-runtime'
import type { ChromiumSharedUnlockRoute } from './chromium-route'
import type { SharedUnlockCoordinatorRoute } from './browser-coordinator'
import type { SharedUnlockOperationMessage } from '../../shared/messaging/shared-unlock-operation'
import { sharedUnlockPreferences } from './preference-state-runtime'
import { sessionManager, sharedUnlockLinks } from '../session/runtime'

vi.mock('../config/server-runtime', () => ({ serverConfig: { apiUrl: 'https://api.test' } }))
const values = vi.hoisted(() => ({} as Record<string, unknown>))
vi.mock('../session/runtime', async () => {
  const { SharedUnlockLinkStore } = await import('./link-store')
  return ({
  sessionManager: {
    hooks: { onLocked: vi.fn(() => () => {}), onUnlocked: vi.fn(() => () => {}) },
    getUserId: async () => '11111111-1111-4111-8111-111111111111', getStatus: async () => 'locked', getKeys: () => null,
    captureSharedUnlockSettingsSession: vi.fn(), captureSharedUnlockSource: vi.fn(), lock: vi.fn(), logout: vi.fn(),
  },
  sharedUnlockSource: { snapshot: () => ({ authorization: null, preference: null, sourceGeneration: null }),
    closingWitness: () => null, subscribe: () => () => {} },
  sharedUnlockLinks: new SharedUnlockLinkStore({ get: async () => structuredClone(values), set: async items => { Object.assign(values, structuredClone(items)) }, remove: async () => {} }), sharedUnlockExpiry: {}, sharedUnlockPreferenceGate: { subscribe: () => () => {}, isAllowed: async () => true, assertAllowed: () => {} },
}) })
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
  return { sent, emit: (message: SharedUnlockOperationMessage) => { for (const listener of listeners) listener(message) } }
}
beforeEach(() => { for (const key of Object.keys(values)) delete values[key]; vi.clearAllMocks(); sharedUnlockPreferences.clear() })
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllGlobals(); sharedUnlockPreferences.clear() })

it('connects locked worker preference repair to its token-only lease without borrowing keys or closing its own session', async () => {
  const dispose = vi.fn()
  vi.mocked(sessionManager.captureSharedUnlockSettingsSession).mockImplementation(() => {
    const abort = new AbortController()
    return { signal: abort.signal, dispose: () => { dispose(); abort.abort() },
      read: () => ({ apiUrl: scope.apiUrl, userId: scope.accountId, accessToken: 'own-worker-access', refreshToken: 'own-worker-refresh' }) }
  })
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ sharedUnlockEnabled: false, revision: 2 })))
  vi.stubGlobal('fetch', fetcher)
  const f = start()
  await vi.waitFor(() => expect(sharedUnlockPreferences.isDisabled(scope)).toBe(true))
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(scope.apiUrl + '/api/account/shared-unlock', expect.objectContaining({
    method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer own-worker-access' }),
  }))
  expect(dispose).toHaveBeenCalledTimes(3)
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
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(3))
  expect(fetcher).not.toHaveBeenCalled(); expect(sharedUnlockPreferences.isDisabled(scope)).toBe(false)
})

it('connects peer reconnect to the locked worker own token lease without borrowing keys or changing login', async () => {
  const linkScope = { ...scope, webOrigin: 'https://web.test', extensionId: 'a'.repeat(32) }
  const linkId = '22222222-2222-4222-8222-222222222222'
  const revoked = { linkId, revision: 2, epoch: 2, state: 'revoked' as const, lastInvalidationSequence: 2, lastLogoutSequence: 0 }
  await sharedUnlockLinks.adopt(linkScope, linkId); await sharedUnlockLinks.observe(linkScope, revoked)
  vi.mocked(sessionManager.captureSharedUnlockSettingsSession).mockImplementation(() => {
    const abort = new AbortController()
    return { signal: abort.signal, dispose: () => abort.abort(), read: () => ({ apiUrl: scope.apiUrl, userId: scope.accountId,
      accessToken: 'own-worker-access', refreshToken: 'own-worker-refresh' }) }
  })
  const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/session-state') ? { action: 'none', link: null } : String(url).endsWith('/' + linkId)
    ? { ...revoked, state: 'locked', revision: 3, epoch: 3, lastInvalidationSequence: 3 }
    : { sharedUnlockEnabled: true, revision: 1 })))
  vi.stubGlobal('fetch', fetcher)
  const f = start()
  f.emit({ attemptId: 'B'.repeat(42) + 'A', payload: { kind: 'link-reconnect', accountId: scope.accountId, linkId, reconnectRevision: 3 } })
  await vi.waitFor(() => expect(f.sent.some(message => message.payload.kind === 'link-reconnect-ack')).toBe(true))
  expect((await sharedUnlockLinks.read(linkScope))?.disconnectId).toBeNull()
  expect(fetcher.mock.calls.every(([url, init]) => new Headers(init?.headers).get('authorization') === 'Bearer own-worker-access'
    && (String(url).endsWith('/session-state') ? init?.method === 'POST' && init.body === JSON.stringify({ linkId, refreshToken: 'own-worker-refresh' }) : init?.method === 'GET'))).toBe(true)
  expect(sessionManager.captureSharedUnlockSource).not.toHaveBeenCalled()
  expect(sessionManager.lock).not.toHaveBeenCalled(); expect(sessionManager.logout).not.toHaveBeenCalled()
})

it('a restarted worker with no own JWT may select a hinted receiver link without clearing revocation or borrowing source keys', async () => {
  const linkScope = { ...scope, webOrigin: 'https://web.test', extensionId: 'a'.repeat(32) }
  const linkId = '22222222-2222-4222-8222-222222222222'
  await sharedUnlockLinks.adopt(linkScope, linkId)
  const marker = await sharedUnlockLinks.observe(linkScope, { linkId, revision: 2, epoch: 2, state: 'revoked', lastInvalidationSequence: 2, lastLogoutSequence: 0 })
  vi.mocked(sessionManager.captureSharedUnlockSettingsSession).mockImplementation(() => { throw new Error('no own JWT') })
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const f = start(), peerId = 'C'.repeat(42) + 'A'
  f.emit({ attemptId: peerId, payload: { kind: 'state', stateId: peerId, accountId: scope.accountId, status: 'unlocked',
    generation: 'D'.repeat(42) + 'A', source: { organizationId: '33333333-3333-4333-8333-333333333333' } } })
  f.emit({ attemptId: 'B'.repeat(42) + 'A', payload: { kind: 'link-reconnect', accountId: scope.accountId, linkId, reconnectRevision: 3 } })
  await vi.waitFor(() => expect(f.sent.some(message => message.payload.kind === 'link')).toBe(true), { timeout: 2000 })
  expect((await sharedUnlockLinks.read(linkScope))?.disconnectId).toBe(marker.disconnectId)
  expect(fetcher).not.toHaveBeenCalled(); expect(sessionManager.captureSharedUnlockSource).not.toHaveBeenCalled()
  expect(sessionManager.lock).not.toHaveBeenCalled(); expect(sessionManager.logout).not.toHaveBeenCalled()
})

it.each(['lock', 'logout'] as const)('uses own Identity %s while the worker is already locked without a RAM root', async action => {
  const linkId = '22222222-2222-4222-8222-222222222222'
  await sharedUnlockLinks.adopt({ ...scope, webOrigin: 'https://web.test', extensionId: 'a'.repeat(32) }, linkId)
  vi.mocked(sessionManager.captureSharedUnlockSettingsSession).mockImplementation(() => {
    const abort = new AbortController()
    return { signal: abort.signal, dispose: () => abort.abort(), read: () => ({ apiUrl: scope.apiUrl, userId: scope.accountId,
      accessToken: 'own-worker-access', refreshToken: 'own-worker-refresh' }) }
  })
  const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/session-state')
    ? { action, link: null } : { sharedUnlockEnabled: false, revision: 2 })))
  vi.stubGlobal('fetch', fetcher); const f = start()
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith(scope.apiUrl + '/api/account/shared-unlock/session-state', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ linkId, refreshToken: 'own-worker-refresh' }),
    headers: expect.objectContaining({ authorization: 'Bearer own-worker-access' }),
  })))
  if (action === 'logout') await vi.waitFor(() => expect(sessionManager.logout).toHaveBeenCalledOnce())
  else expect(sessionManager.logout).not.toHaveBeenCalled()
  expect(sessionManager.lock).not.toHaveBeenCalled()
  expect(sessionManager.captureSharedUnlockSource).not.toHaveBeenCalled()
  expect(f.sent.some(message => message.payload.kind === 'link-invalidated')).toBe(false)
})

it('discards a closing response when the worker own token lease has changed', async () => {
  const linkId = '22222222-2222-4222-8222-222222222222'
  await sharedUnlockLinks.adopt({ ...scope, webOrigin: 'https://web.test', extensionId: 'a'.repeat(32) }, linkId)
  let current = true, finish!: (response: Response) => void
  vi.mocked(sessionManager.captureSharedUnlockSettingsSession).mockImplementation(() => {
    const abort = new AbortController()
    return { signal: abort.signal, dispose: () => abort.abort(), read: () => {
      if (!current) throw new Error('new own session')
      return { apiUrl: scope.apiUrl, userId: scope.accountId, accessToken: 'own-worker-access', refreshToken: 'own-worker-refresh' }
    } }
  })
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/session-state')
    ? new Promise(resolve => { finish = resolve }) : new Response(JSON.stringify({ sharedUnlockEnabled: true, revision: 1 })))
  vi.stubGlobal('fetch', fetcher); start()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  current = false; finish(new Response(JSON.stringify({ action: 'logout', link: null })))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sessionManager.logout).not.toHaveBeenCalled(); expect(sessionManager.lock).not.toHaveBeenCalled()
})
