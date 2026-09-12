import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SharedUnlockApi } from './api'
import { SharedUnlockLinkStore } from './link-store'
import type { StorageArea } from '../session/session-store'
import { startSharedUnlockReconnectMonitor } from './reconnect-monitor'
import type { SharedUnlockCoordinatorRoute } from './browser-coordinator'
import { sharedUnlockOperationSchema, type SharedUnlockOperationMessage } from '../../shared/messaging/shared-unlock-operation'

const scope = { apiUrl: 'https://api.test', webOrigin: 'https://web.test', extensionId: 'a'.repeat(32), accountId: '11111111-1111-4111-8111-111111111111' }
const linkId = '22222222-2222-4222-8222-222222222222'
const revoked = { linkId, revision: 2, epoch: 2, state: 'revoked' as const, lastInvalidationSequence: 2, lastLogoutSequence: 0 }
const reopened = { ...revoked, state: 'locked' as const, revision: 3, epoch: 3, lastInvalidationSequence: 3 }
const hint: SharedUnlockOperationMessage = { attemptId: 'A'.repeat(43), payload: { kind: 'link-reconnect', accountId: scope.accountId, linkId, reconnectRevision: 3 } }
const cleanup: (() => void)[] = []
const tick = () => vi.advanceTimersByTimeAsync(0)
async function setup(accessToken = 'own-access') {
  const values: Record<string, unknown> = {}
  const area: StorageArea = { get: async () => structuredClone(values), set: vi.fn(async items => { Object.assign(values, structuredClone(items)) }), remove: async keys => { for (const key of keys) delete values[key] } }
  const store = new SharedUnlockLinkStore(area)
  await store.adopt(scope, linkId); const marker = await store.observe(scope, revoked)
  const own = { accountId: scope.accountId, apiUrl: scope.apiUrl, generation: 1, present: true }
  const listeners = new Set<(message: SharedUnlockOperationMessage) => void>(), watchers = new Set<() => void>()
  const abort = new AbortController(), changed = vi.fn(), disposed = vi.fn()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(reopened)))
  const route: SharedUnlockCoordinatorRoute = { ...scope, documentBinding: 'own-document', signal: abort.signal,
    close: () => abort.abort(), assertCurrent: () => { if (abort.signal.aborted) throw new Error('closed') },
    verifyCurrent: vi.fn(async () => { route.assertCurrent() }), sendOperation: vi.fn(),
    onOperation: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  let monitor: ReturnType<typeof startSharedUnlockReconnectMonitor> | null = null
  const start = () => {
    monitor?.close()
    monitor = startSharedUnlockReconnectMonitor(route, {
      nonce: async () => 'B'.repeat(42) + 'A', subscribe: watcher => { watchers.add(watcher); return () => { watchers.delete(watcher) } },
      capture: () => {
        if (!own.present) return null
        const generation = own.generation, lease = new AbortController()
        return { session: { apiUrl: own.apiUrl, userId: own.accountId, accessToken, refreshToken: 'own-refresh' }, signal: lease.signal,
          assertCurrent: () => { if (!own.present || own.generation !== generation) throw new Error('own session changed') },
          dispose: () => { disposed(); lease.abort() } }
      },
    }, store, new SharedUnlockApi(fetcher, () => own.apiUrl), changed)
  }
  const emit = (message = hint) => { for (const listener of listeners) listener(sharedUnlockOperationSchema.parse(message)) }
  cleanup.push(() => { monitor?.close(); route.close(); expect(listeners.size).toBe(0); expect(watchers.size).toBe(0) })
  return { store, area, own, route, fetcher, changed, disposed, start, emit, disconnectId: marker.disconnectId!,
    lifecycle: () => { own.generation++; for (const watcher of watchers) watcher() },
    reconnect: () => store.acknowledgeReconnect(scope, linkId, marker.disconnectId!, reopened, () => {}, true) }
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => { for (const close of cleanup.splice(0)) close(); await tick(); const pending = vi.getTimerCount(); vi.useRealTimers(); expect(pending).toBe(0) })

it('delivers an explicit reconnect using the recipient own JWT, then settles only the sender outbox without echo', async () => {
  const web = await setup('own-web'), extension = await setup('own-extension')
  vi.mocked(web.route.sendOperation).mockImplementation(extension.emit)
  vi.mocked(extension.route.sendOperation).mockImplementation(web.emit)
  web.start(); extension.start(); await tick()
  await web.reconnect(); await vi.advanceTimersByTimeAsync(2500)
  expect((await extension.store.read(scope))?.disconnectId).toBeNull()
  expect((await web.store.read(scope))?.reconnectRevision).toBeNull()
  expect(extension.fetcher).toHaveBeenCalledExactlyOnceWith(scope.apiUrl + '/api/account/shared-unlock/links/' + linkId,
    expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer own-extension' }) }))
  expect(web.fetcher).not.toHaveBeenCalled()
  expect(extension.changed).toHaveBeenCalledExactlyOnceWith(scope.accountId)
  expect(vi.mocked(extension.route.sendOperation).mock.calls.map(([m]) => m.payload.kind)).toEqual(['link-reconnect-ack'])
})
it('resends a durable own invitation after route restart and stops after matching ACK', async () => {
  const f = await setup(); await f.reconnect(); f.start(); await tick()
  expect(f.route.sendOperation).toHaveBeenCalledOnce()
  f.start(); await tick(); expect(f.route.sendOperation).toHaveBeenCalledTimes(2)
  f.emit({ ...hint, payload: { ...hint.payload, kind: 'link-reconnect-ack' } as SharedUnlockOperationMessage['payload'] })
  await vi.advanceTimersByTimeAsync(1000)
  expect((await f.store.read(scope))?.reconnectRevision).toBeNull()
  await vi.advanceTimersByTimeAsync(15_000); expect(f.route.sendOperation).toHaveBeenCalledTimes(2)
})
it('ordinary repair never clears revocation without an explicit invitation', async () => {
  const f = await setup(); f.start(); await vi.advanceTimersByTimeAsync(30_000)
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.store.read(scope))?.disconnectId).toBe(f.disconnectId)
})
it('does not select the peer account or link, including with no own JWT', async () => {
  const f = await setup(); f.own.present = false; f.start(); f.emit(); await tick()
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.store.read(scope))?.disconnectId).toBe(f.disconnectId)
  f.own.present = true; f.own.accountId = '33333333-3333-4333-8333-333333333333'; f.lifecycle(); await vi.advanceTimersByTimeAsync(1000)
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.route.sendOperation).not.toHaveBeenCalled()
  f.own.accountId = scope.accountId; f.lifecycle()
  f.emit({ ...hint, payload: { kind: 'link-reconnect', accountId: scope.accountId, linkId: f.own.accountId, reconnectRevision: 3 } })
  await vi.advanceTimersByTimeAsync(1000); expect(f.fetcher).not.toHaveBeenCalled()
})
it('keeps a bounded invitation until an own authenticated lifecycle can check it', async () => {
  const f = await setup(); f.own.present = false; f.start(); f.emit(); await tick()
  f.own.present = true; f.lifecycle(); await vi.advanceTimersByTimeAsync(1000)
  expect((await f.store.read(scope))?.disconnectId).toBeNull(); expect(f.changed).toHaveBeenCalledOnce()
})
it('rejects a newer local disconnect, even after its pending receipt was settled', async () => {
  const f = await setup(); await f.store.observe(scope, { ...revoked, revision: 4, epoch: 4 })
  f.start(); f.emit(); await tick()
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.store.read(scope))?.disconnectId).toBe(f.disconnectId)
})
it('rejects a current Identity revocation, an older response and an unrelated link', async () => {
  for (const response of [revoked, { ...reopened, revision: 2 }, { ...reopened, linkId: scope.accountId }]) {
    const f = await setup(); f.fetcher.mockResolvedValue(new Response(JSON.stringify(response))); f.start(); f.emit(); await tick()
    expect((await f.store.read(scope))?.disconnectId).toBe(f.disconnectId); expect(f.changed).not.toHaveBeenCalled()
  }
})
it('a new local disconnect during the own GET defeats the old invitation', async () => {
  const f = await setup(); let finish!: (response: Response) => void
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })); f.start(); f.emit(); await tick()
  const newer = await f.store.beginClosing(scope, linkId, 'disconnect', 3, null)
  finish(new Response(JSON.stringify(reopened))); await tick()
  expect((await f.store.read(scope))?.disconnectId).toBe(newer.disconnectId); expect(f.changed).not.toHaveBeenCalled()
})
it('late own-session responses and expired uncooperative requests cannot clear the latch', async () => {
  for (const cancelledBy of ['session', 'timeout', 'route'] as const) {
    const f = await setup(); let finish!: (response: Response) => void
    f.fetcher.mockImplementation(() => new Promise(() => {})).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })); f.start(); f.emit(); await tick()
    if (cancelledBy === 'session') f.own.generation++
    else if (cancelledBy === 'route') f.route.close()
    else await vi.advanceTimersByTimeAsync(2000)
    finish(new Response(JSON.stringify(reopened))); await tick()
    expect((await f.store.read(scope))?.disconnectId).toBe(f.disconnectId); expect(f.changed).not.toHaveBeenCalled()
  }
})
it('restores denial when own cancellation happens during the actual clear write', async () => {
  const f = await setup(), write = vi.mocked(f.area.set).getMockImplementation()!
  f.start(); await tick()
  vi.mocked(f.area.set).mockImplementationOnce(async items => { await write(items); f.own.generation++ })
  f.emit(); await vi.advanceTimersByTimeAsync(1000)
  expect((await f.store.read(scope))?.disconnectId).toBe(f.disconnectId); expect(f.changed).not.toHaveBeenCalled()
  expect(f.route.sendOperation).not.toHaveBeenCalled()
})
it('coalesces invitation floods, retains denial offline and bounds hanging route verification', async () => {
  const f = await setup(); f.fetcher.mockRejectedValue(new Error('offline')); f.start(); await tick()
  for (let i = 0; i < 100; i++) f.emit()
  await vi.advanceTimersByTimeAsync(1000); expect(f.fetcher).toHaveBeenCalledOnce()
  expect((await f.store.read(scope))?.disconnectId).toBe(f.disconnectId)
  vi.mocked(f.route.verifyCurrent).mockImplementation(() => new Promise(() => {}))
  f.emit(); await vi.advanceTimersByTimeAsync(3000)
  expect(f.disposed).toHaveBeenCalledTimes(3); expect(f.route.sendOperation).not.toHaveBeenCalled()
})
it('the private browser vocabulary rejects credentials, unknown fields and malformed selectors', () => {
  expect(sharedUnlockOperationSchema.safeParse(hint).success).toBe(true)
  for (const extra of [{ accessToken: 'not-accepted' }, { enabled: true }, { reconnectRevision: -1 }, { accountId: 'invalid' }, { linkId: '' }]) {
    expect(sharedUnlockOperationSchema.safeParse({ ...hint, payload: { ...hint.payload, ...extra } }).success).toBe(false)
  }
})
