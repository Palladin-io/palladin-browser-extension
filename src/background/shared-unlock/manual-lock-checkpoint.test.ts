import { expect, it, vi } from 'vitest'
import { SharedUnlockApi } from './api'
import { SharedUnlockLinkStore } from './link-store'
import { readManualLockCheckpoint } from './manual-lock-checkpoint'

const scope = { accountId: '11111111-1111-4111-8111-111111111111', apiUrl: 'https://api.test',
  webOrigin: 'https://web.test', extensionId: 'a'.repeat(32) }
const linkId = '22222222-2222-4222-8222-222222222222'
const session = { apiUrl: scope.apiUrl, userId: scope.accountId, accessToken: 'own-access', refreshToken: 'own-refresh' }
const link = { linkId, revision: 3, epoch: 3, state: 'locked' as const, lastInvalidationSequence: 3, lastLogoutSequence: 0 }
async function setup() {
  let values: Record<string, unknown> = {}
  const set = vi.fn(async (next: Record<string, unknown>) => { values = { ...values, ...structuredClone(next) } })
  const store = new SharedUnlockLinkStore({ get: async () => structuredClone(values), set, remove: async () => {} },
    () => crypto.randomUUID())
  await store.adopt(scope, linkId)
  // Even a higher persisted observation cannot supply the manual exception.
  await store.observe(scope, { ...link, lastInvalidationSequence: 999 })
  set.mockClear()
  return { store, set }
}
it.each(['none', 'lock', 'logout'] as const)('takes only an authenticated prior lock, never persisted hints or %s authority', async action => {
  const { store, set } = await setup()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ action, link })))
  const result = await readManualLockCheckpoint(scope, session, store, new SharedUnlockApi(fetcher, () => scope.apiUrl),
    new AbortController().signal, () => {})
  expect(result).toEqual(action === 'lock' ? [{ linkId, lastInvalidationSequence: 3 }] : [])
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(scope.apiUrl + '/api/account/shared-unlock/session-state', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ linkId, refreshToken: 'own-refresh' }),
    headers: expect.objectContaining({ authorization: 'Bearer own-access' }),
  }))
  expect(set).not.toHaveBeenCalled()
})
it('rejects an authenticated response that arrives after the captured own session changes', async () => {
  const { store } = await setup()
  let current = true
  const fetcher = vi.fn<typeof fetch>(async () => { current = false; return new Response(JSON.stringify({ action: 'lock', link })) })
  await expect(readManualLockCheckpoint(scope, session, store, new SharedUnlockApi(fetcher, () => scope.apiUrl),
    new AbortController().signal, () => { if (!current) throw new Error('retired own session') })).rejects.toThrow('retired own session')
})
