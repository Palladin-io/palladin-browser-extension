import { expect, it, vi } from 'vitest'
import { SharedUnlockLinkSettings } from './link-settings'
import { SharedUnlockLinkStore } from './link-store'
import { SharedUnlockApi } from './api'
import type { SharedUnlockSettingsSession } from '../session/shared-unlock-settings'

const scope = { apiUrl: 'https://api.test', webOrigin: 'https://web.test', extensionId: 'a'.repeat(32), accountId: '11111111-1111-4111-8111-111111111111' }
const linkId = '22222222-2222-4222-8222-222222222222'
async function setup(disconnected = false) {
  const values: Record<string, unknown> = {}
  const area = { get: async () => structuredClone(values), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)) }), remove: async () => {} }
  const links = new SharedUnlockLinkStore(area)
  let link = { linkId, revision: 1, epoch: 1, state: disconnected ? 'revoked' : 'active', lastInvalidationSequence: 1, lastLogoutSequence: 0 }
  await links.adopt(scope, linkId); await links.observe(scope, { ...link, state: disconnected ? 'revoked' : 'active' })
  const own = { generation: 0, unlocked: true, present: true, apiUrl: scope.apiUrl }
  const tokens = { apiUrl: scope.apiUrl, userId: scope.accountId, accessToken: 'own-access', refreshToken: 'own-refresh' }
  const leases: AbortController[] = []
  const capture = (): SharedUnlockSettingsSession => {
    if (!own.present) throw new Error('missing')
    const generation = own.generation, abort = new AbortController(); leases.push(abort)
    return { signal: abort.signal, dispose: () => abort.abort(), read: () => {
      if (generation !== own.generation || abort.signal.aborted || !own.present) throw new Error('stale')
      return tokens
    } }
  }
  const lock = vi.fn(async (source: SharedUnlockSettingsSession) => {
    source.read(); own.unlocked = false; own.generation++; for (const lease of leases) lease.abort(); return capture()
  })
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/api/account/shared-unlock')) return new Response(JSON.stringify({ sharedUnlockEnabled: false, revision: 1 }))
    if (init?.method === 'POST') link = { ...link, state: String(url).endsWith('/disconnect') ? 'revoked' : 'locked', revision: link.revision + 1, epoch: link.epoch + 1 }
    return new Response(JSON.stringify(link))
  })
  const changed = vi.fn(), announced = vi.fn(); links.subscribeReconnect(announced)
  const worker = new SharedUnlockLinkSettings(capture, lock, () => ({ ...scope, apiUrl: own.apiUrl }), links,
    new SharedUnlockApi(fetcher, () => own.apiUrl), changed)
  const result = await worker.dispatch({ type: 'shared-unlock-link/get' }); if (!result.ok) throw new Error('get failed')
  const action = (kind: 'disconnect' | 'reconnect') => worker.dispatch({ type: `shared-unlock-link/${kind}`, contextId: result.contextId })
  return { own, tokens, lock, fetcher, area, links, worker, action, result, changed, announced }
}
it('disconnect wipes own keys synchronously, uses own Identity even when OFF and preserves local revocation', async () => {
  const f = await setup(); const pending = f.action('disconnect')
  expect(f.own.unlocked).toBe(false)
  expect(await pending).toMatchObject({ ok: true, state: 'disconnected' })
  expect(await f.links.read(scope)).toMatchObject({ pending: [], observed: { state: 'revoked' }, disconnectId: expect.any(String) })
  expect(f.fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer own-access')).toBe(true)
  expect(f.fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})
it('offline disconnect remains locally revoked and never restores keys', async () => {
  const f = await setup(); f.fetcher.mockRejectedValue(new Error('offline'))
  expect(await f.action('disconnect')).toMatchObject({ ok: false })
  expect(f.own.unlocked).toBe(false)
  expect(await f.links.read(scope)).toMatchObject({ disconnectId: expect.any(String), pending: [{ action: 'disconnect' }] })
})
it('explicit reconnect reads own Identity, performs one CAS, announces only after clear and locks for a fresh root', async () => {
  const f = await setup(true)
  expect(await f.action('reconnect')).toMatchObject({ ok: true, state: 'connected' })
  expect(await f.links.read(scope)).toMatchObject({ disconnectId: null, reconnectRevision: 2 })
  expect(f.announced).toHaveBeenCalledOnce(); expect(f.lock).toHaveBeenCalledOnce(); expect(f.own.unlocked).toBe(false)
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})
it('a stale UI context cannot lock the newly selected own session', async () => {
  const f = await setup(); f.own.generation++
  expect(await f.action('disconnect')).toMatchObject({ ok: false })
  expect(f.lock).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.own.unlocked).toBe(true)
})
it('a forged context cannot select an account, pairing or session', async () => {
  const f = await setup()
  expect(await f.worker.dispatch({ type: 'shared-unlock-link/disconnect', contextId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'cancelled' })
  expect(f.lock).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
})
it('a scope change after display prevents both lock and network mutation', async () => {
  const f = await setup(); f.own.apiUrl = 'https://other.test'
  expect(await f.action('disconnect')).toMatchObject({ ok: false }); expect(f.lock).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
})
it('late Identity cannot clear revocation or lock a newer own session', async () => {
  const f = await setup(true); let finish!: (value: Response) => void
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.action('reconnect'); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled())
  f.own.generation++; finish(new Response(JSON.stringify({ linkId, revision: 2, epoch: 2, state: 'locked', lastInvalidationSequence: 2, lastLogoutSequence: 0 })))
  expect(await pending).toMatchObject({ ok: false }); expect((await f.links.read(scope))?.disconnectId).not.toBeNull()
  expect(f.lock).not.toHaveBeenCalled(); expect(f.announced).not.toHaveBeenCalled()
})
it('a newer disconnect after the displayed context defeats the old reconnect', async () => {
  const f = await setup(true), marker = await f.links.beginClosing(scope, linkId, 'disconnect', 1, null)
  expect(await f.action('reconnect')).toMatchObject({ ok: false })
  expect((await f.links.read(scope))?.disconnectId).toBe(marker.disconnectId); expect(f.fetcher).not.toHaveBeenCalled()
})
it('a conflict is not retried with guessed authority', async () => {
  const f = await setup(true); f.fetcher.mockResolvedValue(new Response('{}', { status: 409 }))
  expect(await f.action('reconnect')).toMatchObject({ ok: false, code: 'conflict' })
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.lock).not.toHaveBeenCalled()
})
it('failed clear never publishes an invitation or locks another session', async () => {
  const f = await setup(true); f.area.set.mockRejectedValueOnce(new Error('storage'))
  expect(await f.action('reconnect')).toMatchObject({ ok: false })
  expect((await f.links.repair(scope))?.disconnectId).not.toBeNull(); expect(f.announced).not.toHaveBeenCalled(); expect(f.lock).not.toHaveBeenCalled()
})
it('an explicit retry drains the saved offline disconnect before reconnecting, without changing preference', async () => {
  const f = await setup(); const normal = f.fetcher.getMockImplementation()!
  f.fetcher.mockRejectedValueOnce(new Error('offline'))
  await f.action('disconnect'); f.fetcher.mockImplementation(normal)
  const current = await f.worker.dispatch({ type: 'shared-unlock-link/get' }); if (!current.ok) throw new Error('missing context')
  expect(await f.worker.dispatch({ type: 'shared-unlock-link/reconnect', contextId: current.contextId })).toMatchObject({ ok: true })
  expect(await f.links.read(scope)).toMatchObject({ pending: [], disconnectId: null, observed: { state: 'locked' } })
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url).split('/').at(-1))).toEqual(['disconnect', 'reconnect'])
})
it('a transport ignoring cancellation cannot publish a late reconnect after the ten-second deadline', async () => {
  vi.useFakeTimers()
  try {
    const f = await setup(true); let finish!: (value: Response) => void
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.action('reconnect'); await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    finish(new Response(JSON.stringify({ linkId, revision: 2, epoch: 2, state: 'locked', lastInvalidationSequence: 2, lastLogoutSequence: 0 })))
    await vi.advanceTimersByTimeAsync(0)
    expect((await f.links.read(scope))?.disconnectId).not.toBeNull(); expect(f.lock).not.toHaveBeenCalled(); expect(f.announced).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
it('refreshing after a newer disconnect invalidates the old confirmation context', async () => {
  const f = await setup(true)
  await f.links.beginClosing(scope, linkId, 'disconnect', 1, null)
  const refreshed = await f.worker.dispatch({ type: 'shared-unlock-link/get' })
  expect(refreshed).toMatchObject({ ok: true, state: 'disconnected' })
  if (!refreshed.ok) throw new Error('missing current context')
  expect(refreshed.contextId).not.toBe(f.result.contextId)
  expect(await f.action('reconnect')).toMatchObject({ ok: false, code: 'cancelled' })
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.lock).not.toHaveBeenCalled()
})
