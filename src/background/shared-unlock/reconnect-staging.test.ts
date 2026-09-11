import { expect, it, vi } from 'vitest'
import { SharedUnlockReconnectStaging } from './reconnect-staging'
import { SharedUnlockLinkStore } from './link-store'
import type { StorageArea } from '../session/session-store'
import { SharedUnlockApi } from './api'
import type { SharedUnlockCoordinatorRoute, SharedUnlockSelectedBinding } from './browser-coordinator'

const scope = { apiUrl: 'https://api.test', webOrigin: 'https://web.test', extensionId: 'a'.repeat(32), accountId: '11111111-1111-4111-8111-111111111111' }
const linkId = '22222222-2222-4222-8222-222222222222'
const revoked = { linkId, revision: 2, epoch: 2, state: 'revoked' as const, lastInvalidationSequence: 2, lastLogoutSequence: 0 }
const active = { ...revoked, state: 'active' as const, revision: 4, epoch: 4, lastInvalidationSequence: 3 }
const notice = { accountId: scope.accountId, linkId, reconnectRevision: 3 }
const own = { apiUrl: scope.apiUrl, userId: scope.accountId, accessToken: 'new-own-committed-access', refreshToken: 'new-own-committed-refresh' }
const binding: SharedUnlockSelectedBinding = { ...scope, apiOrigin: scope.apiUrl, linkId, linkEpoch: 4, preferenceRevision: 1,
  organizationId: '33333333-3333-4333-8333-333333333333', documentBinding: 'own-document', webGeneration: 'A'.repeat(43), extensionGeneration: 'B'.repeat(42) + 'A' }
async function setup() {
  const values: Record<string, unknown> = {}
  const area: StorageArea = { get: async () => structuredClone(values), set: vi.fn(async items => { Object.assign(values, structuredClone(items)) }), remove: async () => {} }
  const links = new SharedUnlockLinkStore(area)
  await links.adopt(scope, linkId); const marker = await links.observe(scope, revoked)
  const abort = new AbortController(), changed = vi.fn()
  const route: SharedUnlockCoordinatorRoute = { ...scope, documentBinding: 'own-document', signal: abort.signal,
    close: () => abort.abort(), assertCurrent: () => { if (abort.signal.aborted) throw new Error('retired') },
    verifyCurrent: async () => {}, sendOperation: () => {}, onOperation: () => () => {} }
  const staging = new SharedUnlockReconnectStaging(route, changed)
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(active)))
  const api = new SharedUnlockApi(fetcher, () => scope.apiUrl)
  const confirm = () => staging.capture(marker, binding, links, api).confirm(own, 4, abort.signal, () => {})
  return { links, marker, area, abort, staging, changed, fetcher, api, confirm }
}
it('a hint permits only pending receiver staging and never clears storage or contacts Identity', async () => {
  const f = await setup()
  expect(f.staging.canStage(f.marker)).toBe(false)
  f.staging.observe(notice)
  expect(f.staging.canStage(f.marker, 4)).toBe(true)
  expect((await f.links.read(scope))?.disconnectId).toBe(f.marker.disconnectId)
  expect(f.fetcher).not.toHaveBeenCalled()
  f.staging.observe(notice); f.staging.observe({ ...notice, reconnectRevision: 2 })
  expect(f.changed).toHaveBeenCalledOnce()
})
it('only the own committed session GET can clear the exact latch, without another invitation', async () => {
  const f = await setup(), announced = vi.fn(); f.links.subscribeReconnect(announced); f.staging.observe(notice)
  await f.confirm()
  expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(scope.apiUrl + '/api/account/shared-unlock/links/' + linkId,
    expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer new-own-committed-access' }) }))
  expect(await f.links.read(scope)).toMatchObject({ disconnectId: null, reconnectRevision: null })
  expect(announced).not.toHaveBeenCalled()
})
it('rejects foreign scope/account/link, pending closing, stale notice and old binding epoch before staging', async () => {
  const f = await setup(); f.staging.observe(notice)
  for (const marker of [{ ...f.marker, accountId: binding.organizationId }, { ...f.marker, linkId: binding.organizationId },
    { ...f.marker, apiUrl: 'https://other.test' }, { ...f.marker, extensionId: 'b'.repeat(32) }, { ...f.marker, webOrigin: 'https://other.test' },
    { ...f.marker, observed: { ...revoked, revision: 3 } }, { ...f.marker, observed: null },
    { ...f.marker, pending: [{ id: crypto.randomUUID(), action: 'lock' as const, expectedRevision: 2, preferenceRevision: 1 }] }]) {
    expect(f.staging.canStage(marker, 4)).toBe(false)
  }
  expect(f.staging.canStage(f.marker, 2)).toBe(false)
})
it('rejects current revoked/locked state, mismatched epoch/link, or an authorization older than a closing barrier', async () => {
  for (const response of [revoked, { ...active, state: 'locked' }, { ...active, epoch: 5 }, { ...active, linkId: binding.organizationId },
    { ...active, lastInvalidationSequence: 4 }, { ...active, revision: 2 }]) {
    const f = await setup(); f.staging.observe(notice); f.fetcher.mockResolvedValue(new Response(JSON.stringify(response)))
    await expect(f.confirm()).rejects.toThrow(); expect((await f.links.read(scope))?.disconnectId).toBe(f.marker.disconnectId)
  }
})
it('a different committed account/API cannot authenticate the selected link', async () => {
  const f = await setup(); f.staging.observe(notice); const captured = f.staging.capture(f.marker, binding, f.links, f.api)
  for (const session of [{ ...own, userId: binding.organizationId }, { ...own, apiUrl: 'https://other.test' }]) {
    await expect(captured.confirm(session, 4, f.abort.signal, () => {})).rejects.toThrow()
  }
  expect(f.fetcher).not.toHaveBeenCalled()
})
it('a newer local disconnect defeats a valid but late own Identity response', async () => {
  const f = await setup(); f.staging.observe(notice); let finish!: (value: Response) => void
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.confirm(); const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled())
  const newer = await f.links.beginClosing(scope, linkId, 'disconnect', 4, null)
  finish(new Response(JSON.stringify(active))); await rejected
  expect((await f.links.read(scope))?.disconnectId).toBe(newer.disconnectId)
})
it('cancellation during the actual clear restores local revocation', async () => {
  const f = await setup(); f.staging.observe(notice); const write = vi.mocked(f.area.set).getMockImplementation()!
  vi.mocked(f.area.set).mockImplementationOnce(async items => { await write(items); f.abort.abort() })
  await expect(f.confirm()).rejects.toThrow()
  expect((await f.links.read(scope))?.disconnectId).toBe(f.marker.disconnectId)
})
it('a changed invitation invalidates the captured attempt without renewing it', async () => {
  const f = await setup(); f.staging.observe(notice); const captured = f.staging.capture(f.marker, binding, f.links, f.api)
  f.staging.observe({ ...notice, reconnectRevision: 4 })
  expect(captured.assertCurrent).toThrow(); await expect(captured.confirm(own, 4, f.abort.signal, () => {})).rejects.toThrow()
  expect(f.fetcher).not.toHaveBeenCalled()
})
it('normal receivers still reject a local disconnect created after their initial admission', async () => {
  const f = await setup()
  const cleared = await f.links.acknowledgeReconnect(scope, linkId, f.marker.disconnectId!, active)
  const captured = f.staging.capture(cleared, binding, f.links, f.api)
  await f.links.beginClosing(scope, linkId, 'disconnect', 4, null)
  await expect(captured.confirm(own, 4, f.abort.signal, () => {})).rejects.toThrow()
  expect(f.fetcher).not.toHaveBeenCalled()
})
it('bounds an uncooperative own GET and rejects its late response', async () => {
  vi.useFakeTimers()
  try {
    const f = await setup(); f.staging.observe(notice); let finish!: (value: Response) => void
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.confirm(), rejected = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(2000); await rejected
    finish(new Response(JSON.stringify(active))); await vi.advanceTimersByTimeAsync(0)
    expect((await f.links.read(scope))?.disconnectId).toBe(f.marker.disconnectId); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('normal admission also binds the stored scope and selected document to the independent live route', async () => {
  const f = await setup(), marker = await f.links.acknowledgeReconnect(scope, linkId, f.marker.disconnectId!, active)
  for (const foreign of [{ ...marker, apiUrl: 'https://other.test' }, { ...marker, webOrigin: 'https://other.test' }, { ...marker, extensionId: 'b'.repeat(32) }]) {
    expect(() => f.staging.capture(foreign, binding, f.links, f.api)).toThrow()
  }
  expect(() => f.staging.capture(marker, { ...binding, documentBinding: 'another-document' }, f.links, f.api)).toThrow()
  expect(() => f.staging.capture(marker, { ...binding, apiOrigin: 'https://other.test' }, f.links, f.api)).toThrow()
  expect(f.fetcher).not.toHaveBeenCalled()
})
