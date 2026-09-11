// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SharedUnlockSettings } from './SharedUnlockSettings'
import { SharedUnlockSettings as WorkerSettings } from '../../background/shared-unlock/settings'
import { SharedUnlockPreferenceGate } from '../../background/shared-unlock/preference-gate'
import { SharedUnlockApiError } from '../../background/shared-unlock/api'
import { I18nProvider } from '../i18n'
import fixtures from '../../background/shared-unlock/fixtures/session-api-v1.json'

const root = fixtures.operations[0].sourceAuthorization
const tokens = { apiUrl: 'https://api.test', userId: root.accountId, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }
const scope = { accountId: tokens.userId, apiUrl: tokens.apiUrl }
const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
// jsdom25 lacks the worker's native AbortSignal.any. Keep the substitute local
// to this component/worker integration test; native browser proof is separate.
beforeAll(() => { Object.defineProperty(AbortSignal, 'any', { configurable: true, value: (signals: AbortSignal[]) => {
  const abort = new AbortController(), cancel = () => abort.abort()
  abort.signal.addEventListener('abort', () => { for (const signal of signals) signal.removeEventListener('abort', cancel) }, { once: true })
  for (const signal of signals) {
    if (signal.aborted) { cancel(); break }
    signal.addEventListener('abort', cancel, { once: true })
  }
  return abort.signal
} }) })
afterAll(() => { if (originalAny) Object.defineProperty(AbortSignal, 'any', originalAny); else Reflect.deleteProperty(AbortSignal, 'any') })
function setup() {
  let preference = { sharedUnlockEnabled: true, revision: 3 }
  const values: Record<string, unknown> = {}, abort = new AbortController(), listeners = new Set<(sessionChanged: boolean) => void>()
  const changed = () => { for (const listener of listeners) listener(false) }
  const subscribe = (listener: (sessionChanged: boolean) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const gate = new SharedUnlockPreferenceGate({ get: async () => values, set: async next => { Object.assign(values, next) } })
  const api = { readPreference: vi.fn(async () => ({ ...preference })),
    setPreference: vi.fn(async (_session: typeof tokens, enabled: boolean, revision: number) => {
      if (revision !== preference.revision) throw new SharedUnlockApiError('conflict')
      preference = { sharedUnlockEnabled: enabled, revision: revision + 1 }; return { ...preference }
    }) }
  const worker = new WorkerSettings(() => {
    if (abort.signal.aborted) throw new Error('signed out')
    return { signal: abort.signal, dispose: () => abort.abort(), read: () => {
      if (abort.signal.aborted) throw new Error('signed out')
      return tokens
    } }
  }, api, gate, () => {}, changed)
  const send = vi.fn(worker.dispatch.bind(worker))
  return { send, subscribe, api, gate, abort, listeners,
    externalChoice(enabled: boolean) { preference = { sharedUnlockEnabled: enabled, revision: preference.revision + 1 }; changed() },
    sessionChanged() { for (const listener of listeners) listener(true) } }
}
afterEach(() => cleanup())
describe('shared popup and side-panel account preference', () => {
  it('uses one worker state from both hosts and accepts external account refreshes', async () => {
    const f = setup(), user = userEvent.setup()
    await expect(f.send({ type: 'shared-unlock-settings/get' })).resolves.toMatchObject({ ok: true })
    const view = render(<><div aria-label="popup"><SharedUnlockSettings {...f} /></div>
      <div aria-label="side-panel"><SharedUnlockSettings {...f} /></div></>)
    const popup = within(view.container.querySelector('[aria-label="popup"]')!), panel = within(view.container.querySelector('[aria-label="side-panel"]')!)
    const a = await popup.findByRole('switch'), b = await panel.findByRole('switch')
    expect(a).toHaveAttribute('aria-checked', 'true'); expect(b).toHaveAttribute('aria-checked', 'true')
    a.focus(); await user.keyboard(' ')
    await waitFor(() => expect(b).toHaveAttribute('aria-checked', 'false'))
    await waitFor(() => expect(a).toBeEnabled())
    await user.click(b)
    await waitFor(() => expect(a).toHaveAttribute('aria-checked', 'true'))
    expect(f.api.setPreference).toHaveBeenCalledTimes(2)
    await act(async () => f.externalChoice(false))
    await waitFor(() => expect(a).toHaveAttribute('aria-checked', 'false'))
    await waitFor(() => expect(b).toHaveAttribute('aria-checked', 'false'))
    expect(f.api.setPreference).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).not.toMatch(/synthetic|111111|contextId|operationId/)
    view.unmount(); expect(f.listeners.size).toBe(0)
  })
  it('shows a failed OFF as paused and retries only the explicit choice', async () => {
    const f = setup(); render(<SharedUnlockSettings {...f} />)
    const toggle = await screen.findByRole('switch')
    f.api.setPreference.mockRejectedValueOnce(new SharedUnlockApiError('network'))
    fireEvent.click(toggle)
    expect(() => f.gate.assertAllowed(scope)).toThrow()
    expect(await screen.findByRole('alert')).toHaveTextContent('locally paused')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(await f.gate.isAllowed(scope)).toBe(false)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(f.api.setPreference).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
  it('retains pause after a CAS conflict and displays the newly read account value', async () => {
    const f = setup(); render(<SharedUnlockSettings {...f} />)
    const toggle = await screen.findByRole('switch')
    f.api.setPreference.mockImplementationOnce(async () => { f.externalChoice(false); throw new SharedUnlockApiError('conflict') })
    await userEvent.setup().click(toggle)
    expect(await screen.findByRole('alert')).toHaveTextContent('changed elsewhere')
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(f.api.setPreference).toHaveBeenCalledOnce(); expect(await f.gate.isAllowed(scope)).toBe(false)
  })
  it('does not expose a toggle when signed out and provides Polish instructions', async () => {
    const f = setup(); f.abort.abort()
    render(<I18nProvider locale="pl"><SharedUnlockSettings {...f} /></I18nProvider>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Zaloguj się')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument(); expect(f.api.setPreference).not.toHaveBeenCalled()
  })
  it('ignores the previous screen save after its session changes', async () => {
    const f = setup(); render(<SharedUnlockSettings {...f} />)
    const toggle = await screen.findByRole('switch'); let finish!: () => void
    f.api.setPreference.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ sharedUnlockEnabled: false, revision: 4 }) }))
    fireEvent.click(toggle); await waitFor(() => expect(finish).toBeDefined())
    await act(async () => { f.abort.abort(); f.sessionChanged(); finish() })
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument(); expect(await f.gate.isAllowed(scope)).toBe(false)
  })
})
