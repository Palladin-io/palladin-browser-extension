import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedUnlockApiError } from './api'
import { SharedUnlockPreferenceGate } from './preference-gate'
import { SharedUnlockSettings } from './settings'
import fixtures from './fixtures/session-api-v1.json'

const root = fixtures.operations[0].sourceAuthorization
const tokens = { apiUrl: 'https://api.test', userId: root.accountId, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }
const scope = { apiUrl: tokens.apiUrl, accountId: tokens.userId }
function setup() {
  const values: Record<string, unknown> = {}
  const storage = { get: async () => structuredClone(values), set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next) }) }
  const gate = new SharedUnlockPreferenceGate(storage), abort = new AbortController()
  const read = () => {
    if (abort.signal.aborted) throw new Error('old own session')
    return tokens
  }
  const capture = vi.fn(() => ({ signal: abort.signal, read, dispose: () => abort.abort() }))
  const api = { readPreference: vi.fn(async () => ({ sharedUnlockEnabled: true, revision: 3 })),
    setPreference: vi.fn(async (_session: typeof tokens, enabled: boolean) => ({ sharedUnlockEnabled: enabled, revision: 4 })) }
  const accept = vi.fn(), changed = vi.fn()
  const settings = new SharedUnlockSettings(capture, api, gate, accept, changed)
  async function command(enabled = false) {
    const current = await settings.dispatch({ type: 'shared-unlock-settings/get' })
    if (!current.ok) throw new Error('No settings context')
    return { type: 'shared-unlock-settings/set' as const, contextId: current.contextId, revision: current.revision, enabled }
  }
  return { settings, command, api, gate, storage, values, abort, capture, changed, accept }
}
afterEach(() => vi.useRealTimers())
describe('worker-owned shared unlock account settings', () => {
  it('serves both UI hosts from one live context without emitting own credentials', async () => {
    const f = setup()
    const [popup, sidePanel] = await Promise.all([f.settings.dispatch({ type: 'shared-unlock-settings/get' }), f.settings.dispatch({ type: 'shared-unlock-settings/get' })])
    expect(popup).toEqual(sidePanel); expect(f.capture).toHaveBeenCalledOnce()
    expect(popup).toMatchObject({ ok: true, sharedUnlockEnabled: true, revision: 3, locallyPaused: false })
    expect(JSON.stringify(popup)).not.toMatch(/synthetic|masterKey|privateKey|accountId|accessToken|refreshToken/)
    expect(f.abort.signal.aborted).toBe(false)
  })
  it.each([false, true])('pauses synchronously, then writes %s with own session/CAS and settles the exact marker', async enabled => {
    const f = setup(), command = await f.command(enabled)
    const saved = f.settings.dispatch(command)
    expect(() => f.gate.assertAllowed(scope)).toThrow()
    expect(f.changed).toHaveBeenCalledOnce()
    expect(await saved).toMatchObject({ ok: true, sharedUnlockEnabled: enabled, revision: 4, locallyPaused: false })
    expect(f.api.setPreference).toHaveBeenCalledExactlyOnceWith(tokens, enabled, 3, expect.any(AbortSignal))
    expect(await new SharedUnlockPreferenceGate(f.storage).isAllowed(scope)).toBe(true)
    expect(f.abort.signal.aborted).toBe(false)
  })
  it.each(['network', 'conflict'] as const)('retains denial after %s with no automatic write retry', async code => {
    const f = setup(), command = await f.command(); f.api.setPreference.mockRejectedValue(new SharedUnlockApiError(code))
    expect(await f.settings.dispatch(command)).toMatchObject({ ok: false, code: code === 'conflict' ? code : 'unavailable', locallyPaused: true })
    expect(f.api.setPreference).toHaveBeenCalledOnce()
    expect(await new SharedUnlockPreferenceGate(f.storage).isAllowed(scope)).toBe(false)
  })
  it('does not mutate from a signed-out or stale UI context', async () => {
    const f = setup(), command = await f.command(); f.abort.abort()
    expect(await f.settings.dispatch(command)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await f.settings.dispatch({ type: 'shared-unlock-settings/get' })).toMatchObject({ ok: false, code: 'authentication-required' })
    expect(f.api.setPreference).not.toHaveBeenCalled(); expect(await f.gate.isAllowed(scope)).toBe(true)
  })
  it('never lets an old UI context write or pause the next account', async () => {
    const f = setup(), old = await f.command(); f.abort.abort()
    const nextTokens = { ...tokens, userId: '22222222-2222-4222-8222-222222222222' }, nextAbort = new AbortController()
    f.capture.mockReturnValueOnce({ signal: nextAbort.signal, read: () => nextTokens, dispose: () => nextAbort.abort() })
    const next = await f.settings.dispatch({ type: 'shared-unlock-settings/get' })
    expect(next.ok).toBe(true); if (!next.ok) throw new Error('Missing next settings context')
    expect(next.contextId).not.toBe(old.contextId)
    expect(await f.settings.dispatch(old)).toMatchObject({ ok: false, code: 'cancelled', locallyPaused: false })
    expect(f.api.setPreference).not.toHaveBeenCalled()
    expect(await f.gate.isAllowed({ ...scope, accountId: nextTokens.userId })).toBe(true)
    nextAbort.abort()
  })
  it('rejects a late successful save after own lock and retains the pause', async () => {
    const f = setup(), command = await f.command(); let finish!: () => void
    f.api.setPreference.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ sharedUnlockEnabled: false, revision: 4 }) }))
    const saved = f.settings.dispatch(command)
    await vi.waitFor(() => expect(finish).toBeDefined()); f.accept.mockClear(); f.abort.abort(); finish()
    expect(await saved).toMatchObject({ ok: false, code: 'cancelled', locallyPaused: true })
    expect(f.accept).not.toHaveBeenCalled(); expect(await f.gate.isAllowed(scope)).toBe(false)
  })
  it('bounds an unresponsive Identity save and rejects its late success', async () => {
    vi.useFakeTimers()
    const f = setup(), command = await f.command(); let finish!: () => void
    f.api.setPreference.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ sharedUnlockEnabled: false, revision: 4 }) }))
    const saved = f.settings.dispatch(command)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await saved).toMatchObject({ ok: false, locallyPaused: true })
    f.accept.mockClear(); finish(); await Promise.resolve()
    expect(f.accept).not.toHaveBeenCalled(); expect(await f.gate.isAllowed(scope)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('never sends a mutation if the pause cannot be persisted', async () => {
    const f = setup(), command = await f.command(); f.storage.set.mockRejectedValue(new Error('disk'))
    expect(await f.settings.dispatch(command)).toMatchObject({ ok: false, locallyPaused: true })
    expect(f.api.setPreference).not.toHaveBeenCalled(); expect(await f.gate.isAllowed(scope)).toBe(false)
  })
  it('requires authentication after own JWT rejection without replay or clearing denial', async () => {
    const f = setup(), command = await f.command()
    f.api.setPreference.mockRejectedValue(new SharedUnlockApiError('unauthorized'))
    expect(await f.settings.dispatch(command)).toMatchObject({ ok: false, code: 'authentication-required', locallyPaused: true })
    expect(f.api.setPreference).toHaveBeenCalledOnce()
    expect(await f.gate.isAllowed(scope)).toBe(false)
  })
})
