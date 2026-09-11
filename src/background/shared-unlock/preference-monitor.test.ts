import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SharedUnlockApi } from './api'
import { SharedUnlockPreferenceState } from './preference-state'
import { SharedUnlockPreferenceGate } from './preference-gate'
import { startSharedUnlockPreferenceMonitor } from './preference-monitor'
import type { SharedUnlockCoordinatorRoute } from './browser-coordinator'
import { sharedUnlockOperationSchema, type SharedUnlockOperationMessage } from '../../shared/messaging/shared-unlock-operation'

const scope = { apiUrl: 'https://api.test', accountId: '11111111-1111-4111-8111-111111111111' }
const hint: SharedUnlockOperationMessage = { attemptId: 'A'.repeat(43), payload: { kind: 'preference-invalidated' } }
const tick = () => vi.advanceTimersByTimeAsync(0)
function setup(accessToken = 'own-access', prepare?: (own: { userId: string; apiUrl: string; generation: number; present: boolean }, fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => void) {
  const state = new SharedUnlockPreferenceState(), routeAbort = new AbortController()
  const listeners = new Set<(message: SharedUnlockOperationMessage) => void>(), watchers = new Set<() => void>()
  const own = { userId: scope.accountId, apiUrl: scope.apiUrl, generation: 1, present: true }
  let preference = { sharedUnlockEnabled: true, revision: 1 }
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(preference)))
  const disposed = vi.fn(), observed = vi.fn(); state.subscribe(observed)
  const route: SharedUnlockCoordinatorRoute = { apiUrl: scope.apiUrl, webOrigin: 'https://web.test', extensionId: 'a'.repeat(32), documentBinding: 'own-document',
    signal: routeAbort.signal, assertCurrent: () => { if (routeAbort.signal.aborted) throw new Error('retired') },
    verifyCurrent: vi.fn(async () => { route.assertCurrent() }), close: () => routeAbort.abort(), sendOperation: vi.fn(),
    onOperation: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  prepare?.(own, fetcher)
  const monitor = startSharedUnlockPreferenceMonitor(route, {
    nonce: async () => 'A'.repeat(43), subscribe: listener => { watchers.add(listener); return () => { watchers.delete(listener) } },
    capture: () => {
      if (!own.present) return null
      const generation = own.generation, abort = new AbortController()
      return { session: { userId: own.userId, apiUrl: own.apiUrl, accessToken, refreshToken: 'own-refresh' }, signal: abort.signal,
        assertCurrent: () => { if (!own.present || generation !== own.generation) throw new Error('own session changed') },
        dispose: () => { disposed(); abort.abort() } }
    },
  }, state, new SharedUnlockApi(fetcher, () => own.apiUrl))
  return { state, route, own, fetcher, observed, disposed, watchers, listeners,
    setPreference(value: typeof preference) { preference = value },
    emit: () => { for (const listener of listeners) listener(hint) },
    ownChanged: () => { own.generation++; for (const watcher of watchers) watcher() },
    close: () => { monitor.close(); route.close() } }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { const pending = vi.getTimerCount(); vi.useRealTimers(); expect(pending).toBe(0) })

describe('own authenticated account preference repair', () => {
  it('refreshes outside Settings, including missed hints, without sending mutations or activity', async () => {
    const f = setup(); await tick()
    f.setPreference({ sharedUnlockEnabled: false, revision: 2 }); await vi.advanceTimersByTimeAsync(15_000)
    expect(f.state.isDisabled(scope)).toBe(true)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.fetcher.mock.calls.every(([url, init]) => url === scope.apiUrl + '/api/account/shared-unlock'
      && init?.method === 'GET' && (init.headers as Record<string, string>).authorization === 'Bearer own-access')).toBe(true)
    expect(f.route.sendOperation).not.toHaveBeenCalled(); f.close()
  })
  it('uses only a value-free saved hint and the recipient own JWT, without echo', async () => {
    const a = setup('own-web'), b = setup('own-extension'); await tick()
    vi.mocked(a.route.sendOperation).mockImplementation(message => {
      expect(sharedUnlockOperationSchema.parse(message)).toEqual(hint); b.emit()
    })
    a.setPreference({ sharedUnlockEnabled: false, revision: 2 }); b.setPreference({ sharedUnlockEnabled: false, revision: 2 })
    a.state.saved(scope); await vi.advanceTimersByTimeAsync(1000)
    expect(a.state.isDisabled(scope)).toBe(true); expect(b.state.isDisabled(scope)).toBe(true)
    expect(a.route.sendOperation).toHaveBeenCalledOnce(); expect(b.route.sendOperation).not.toHaveBeenCalled()
    expect(b.fetcher.mock.calls.at(-1)![1]).toMatchObject({ headers: { authorization: 'Bearer own-extension' } })
    a.close(); b.close()
  })
  it('coalesces a hint flood into at most one fresh read per second', async () => {
    const f = setup(); await tick()
    for (let i = 0; i < 100; i++) f.emit()
    await vi.advanceTimersByTimeAsync(1000); expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.observed).toHaveBeenCalledOnce(); f.close()
  })
  it('rejects an old response after its own account generation changes', async () => {
    let finish!: (response: Response) => void
    const f = setup('own-access', (_own, fetcher) => { fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })) })
    await tick(); f.ownChanged(); f.own.userId = '22222222-2222-4222-8222-222222222222'
    finish(new Response(JSON.stringify({ sharedUnlockEnabled: false, revision: 99 })))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.state.isDisabled(scope)).toBe(false)
    expect(f.observed).toHaveBeenCalledExactlyOnceWith({ scope: { ...scope, accountId: f.own.userId }, preference: { sharedUnlockEnabled: true, revision: 1 } })
    f.close()
  })
  it('times out an uncooperative request and ignores its late body', async () => {
    let finish!: (response: Response) => void
    const f = setup('own-access', (_own, fetcher) => { fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })) })
    await vi.advanceTimersByTimeAsync(2000)
    finish(new Response(JSON.stringify({ sharedUnlockEnabled: false, revision: 99 }))); await tick()
    expect(f.observed).not.toHaveBeenCalled(); expect(f.disposed).toHaveBeenCalledOnce(); f.close()
  })
  it('does not derive an account or bearer from peer traffic when own authentication is absent', async () => {
    const f = setup('own-access', own => { own.present = false })
    await tick(); f.emit(); f.state.saved(scope); await vi.advanceTimersByTimeAsync(1000)
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.route.sendOperation).not.toHaveBeenCalled(); f.close()
  })
  it('does not send a saved hint for another account or API', async () => {
    const f = setup(); await tick()
    f.state.saved({ ...scope, accountId: '22222222-2222-4222-8222-222222222222' })
    f.state.saved({ ...scope, apiUrl: 'https://other.test' }); await tick()
    expect(f.route.sendOperation).not.toHaveBeenCalled(); f.close()
  })
  it('retains an observed OFF on network failure but forgets its rejected own JWT without clearing a local pause', async () => {
    const f = setup(); await tick(); f.state.observe(scope, { sharedUnlockEnabled: false, revision: 2 })
    const values: Record<string, unknown> = {}, gate = new SharedUnlockPreferenceGate({ get: async () => values, set: async next => { Object.assign(values, next) } })
    await gate.pause(scope).persisted
    f.fetcher.mockRejectedValueOnce(new Error('offline')); f.emit(); await vi.advanceTimersByTimeAsync(1000)
    expect(f.state.isDisabled(scope)).toBe(true)
    f.fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 })); f.emit(); await vi.advanceTimersByTimeAsync(1000)
    expect(f.state.isDisabled(scope)).toBe(false); expect(await gate.isAllowed(scope)).toBe(false)
    expect(f.route.sendOperation).not.toHaveBeenCalled(); f.close()
  })
  it('retires pending reads and outgoing verification on route close', async () => {
    const f = setup(); await tick(); let finish!: () => void
    vi.mocked(f.route.verifyCurrent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    f.state.saved(scope); await tick(); f.close(); finish(); await tick()
    expect(f.route.sendOperation).not.toHaveBeenCalled(); expect(f.watchers.size + f.listeners.size).toBe(0)
  })
  it('accepts no preference value, account, or credentials in the peer hint', () => {
    expect(sharedUnlockOperationSchema.safeParse(hint).success).toBe(true)
    for (const extra of [{ enabled: true }, { accountId: scope.accountId }, { accessToken: 'synthetic' }]) {
      expect(sharedUnlockOperationSchema.safeParse({ ...hint, payload: { ...hint.payload, ...extra } }).success).toBe(false)
    }
  })
})
