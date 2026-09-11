import { describe, expect, it, vi } from 'vitest'
import { SharedUnlockExpiryStore } from './expiry-store'

const scope = { accountId: '11111111-1111-4111-8111-111111111111', apiUrl: 'https://api.example.test' }
function storage() {
  const values: Record<string, unknown> = {}
  return { values, get: vi.fn(async () => structuredClone(values)), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)) }) }
}
const make = (s: ReturnType<typeof storage>) => new SharedUnlockExpiryStore(s, action => action())

describe('own retired authorization sequence', () => {
  it('survives restart, is monotonic, and permits only a newer own authorization', async () => {
    const s = storage(), store = make(s)
    await Promise.all([store.advance(scope, 9), store.advance(scope, 4)])
    const restarted = make(s)
    await expect(restarted.assertFresh(scope, 9)).rejects.toThrow('retired locally')
    await expect(restarted.assertFresh(scope, 10)).resolves.toBeUndefined()
    expect(Object.values(s.values)).toEqual([{ version: 1, ...scope, throughSequence: 9 }])
  })
  it('keeps different accounts and API environments independent', async () => {
    const store = make(storage()); await store.advance(scope, 9)
    await expect(store.assertFresh({ ...scope, apiUrl: 'https://other.example.test' }, 1)).resolves.toBeUndefined()
    await expect(store.assertFresh({ ...scope, accountId: '22222222-2222-4222-8222-222222222222' }, 1)).resolves.toBeUndefined()
  })
  it('retains failed persistence in RAM and repairs before accepting even a newer root', async () => {
    const s = storage(), store = make(s)
    s.set.mockRejectedValueOnce(new Error('disk unavailable')).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(store.advance(scope, 9)).rejects.toThrow('disk unavailable')
    await expect(store.assertFresh(scope, 10)).rejects.toThrow('disk unavailable')
    await expect(store.assertFresh(scope, 9)).rejects.toThrow('retired locally')
    await expect(make(s).assertFresh(scope, 9)).rejects.toThrow('retired locally')
  })
  it('rejects corrupt or scope-substituted persisted bytes', async () => {
    const s = storage(), store = make(s); await store.advance(scope, 9)
    const key = Object.keys(s.values)[0]
    for (const value of [null, { version: 1, ...scope, throughSequence: -1 }, { version: 1, ...scope, apiUrl: 'https://other.example.test', throughSequence: 9 }]) {
      s.values[key] = value
      await expect(store.assertFresh(scope, 10)).rejects.toThrow('record unavailable')
    }
  })
  it('uses only the matching remembered own receipt and fences immediately before storage completes', async () => {
    const s = storage(), store = make(s)
    store.remember(scope, 9)
    store.retire({ ...scope, apiUrl: 'https://other.example.test' })
    await expect(store.assertFresh(scope, 9)).resolves.toBeUndefined()
    store.retire(scope)
    await expect(store.assertFresh(scope, 9)).rejects.toThrow('retired locally')
  })
  it('fences retirement arriving while an earlier admission reads storage', async () => {
    const s = storage(), store = make(s)
    let release!: () => void
    s.get.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}) }))
    const admission = expect(store.assertFresh(scope, 9)).rejects.toThrow('retired locally')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const retirement = store.advance(scope, 9)
    release(); await admission; await retirement
    await expect(make(s).assertFresh(scope, 9)).rejects.toThrow('retired locally')
  })
})
