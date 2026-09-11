import { expect, it, vi } from 'vitest'
import { SharedUnlockLinkStore } from './link-store'
import type { StorageArea } from '../session/session-store'

const scope = { apiUrl: 'https://api.test', webOrigin: 'https://web.test', extensionId: 'a'.repeat(32), accountId: '11111111-1111-4111-8111-111111111111' }
const linkId = '22222222-2222-4222-8222-222222222222'
const revoked = { linkId, revision: 2, epoch: 2, state: 'revoked' as const, lastInvalidationSequence: 2, lastLogoutSequence: 0 }
const reopened = { ...revoked, state: 'locked' as const, revision: 3, epoch: 3, lastInvalidationSequence: 3 }
async function setup() {
  const values: Record<string, unknown> = {}
  const area: StorageArea = { get: async () => structuredClone(values), set: vi.fn(async next => { Object.assign(values, structuredClone(next)) }),
    remove: async keys => { for (const key of keys) delete values[key] } }
  const store = new SharedUnlockLinkStore(area)
  await store.adopt(scope, linkId); const marker = await store.observe(scope, revoked)
  return { area, store, id: marker.disconnectId! }
}
it('retains disconnect after a failed clear, including later repair', async () => {
  const f = await setup()
  vi.mocked(f.area.set).mockRejectedValueOnce(new Error('disk'))
  await expect(f.store.acknowledgeReconnect(scope, linkId, f.id, reopened)).rejects.toThrow('disk')
  expect((await f.store.repair(scope))?.disconnectId).toBe(f.id)
  expect((await new SharedUnlockLinkStore(f.area).read(scope))?.disconnectId).toBe(f.id)
})
it('restores the exact disconnect if own cancellation arrives during the clear write', async () => {
  const f = await setup(), original = vi.mocked(f.area.set).getMockImplementation()!; let current = true
  vi.mocked(f.area.set).mockImplementationOnce(async items => { await original(items); current = false })
  await expect(f.store.acknowledgeReconnect(scope, linkId, f.id, reopened, () => {
    if (!current) throw new Error('old own session')
  })).rejects.toThrow('old own session')
  expect((await f.store.read(scope))?.disconnectId).toBe(f.id)
})
it('keeps RAM denial if both the clear and restoration fail', async () => {
  const f = await setup()
  vi.mocked(f.area.set).mockRejectedValue(new Error('disk'))
  await expect(f.store.acknowledgeReconnect(scope, linkId, f.id, reopened)).rejects.toThrow('disk')
  await expect(f.store.read(scope)).rejects.toThrow()
  vi.mocked(f.area.set).mockImplementation(async () => {})
  expect((await f.store.repair(scope))?.disconnectId).toBe(f.id)
})
it('an already cancelled owner cannot start clearing local revocation', async () => {
  const f = await setup(); vi.mocked(f.area.set).mockClear()
  expect(() => f.store.acknowledgeReconnect(scope, linkId, f.id, reopened, () => { throw new Error('cancelled') })).toThrow('cancelled')
  expect(f.area.set).not.toHaveBeenCalled()
})
