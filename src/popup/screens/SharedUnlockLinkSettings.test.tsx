// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { SharedUnlockLinkSettings } from './SharedUnlockLinkSettings'
import { SharedUnlockLinkSettings as Worker } from '../../background/shared-unlock/link-settings'
import { SharedUnlockLinkStore } from '../../background/shared-unlock/link-store'
import { SharedUnlockApi } from '../../background/shared-unlock/api'
import { I18nProvider } from '../i18n'

const scope = { apiUrl: 'https://api.test', webOrigin: 'https://web.test', extensionId: 'a'.repeat(32), accountId: '11111111-1111-4111-8111-111111111111' }
const linkId = '22222222-2222-4222-8222-222222222222'
async function setup(disconnected = false) {
  const values: Record<string, unknown> = {}, listeners = new Set<(changed: boolean) => void>()
  const links = new SharedUnlockLinkStore({ get: async () => structuredClone(values), set: async items => { Object.assign(values, structuredClone(items)) }, remove: async () => {} })
  let link = { linkId, revision: 1, epoch: 1, state: (disconnected ? 'revoked' : 'active') as 'active' | 'locked' | 'revoked', lastInvalidationSequence: 1, lastLogoutSequence: 0 }
  await links.adopt(scope, linkId); await links.observe(scope, link)
  const tokens = { apiUrl: scope.apiUrl, userId: scope.accountId, accessToken: 'own-access', refreshToken: 'own-refresh' }
  let generation = 0
  const capture = () => {
    const selected = generation, abort = new AbortController()
    return { signal: abort.signal, read: () => { if (selected !== generation || abort.signal.aborted) throw new Error('stale'); return tokens }, dispose: () => abort.abort() }
  }
  const lock = vi.fn(async (source: ReturnType<typeof capture>) => { source.read(); generation++; source.dispose(); return capture() })
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') link = { ...link, state: String(_url).endsWith('/disconnect') ? 'revoked' : 'locked', revision: 2, epoch: 2 }
    return new Response(JSON.stringify(String(_url).endsWith('/api/account/shared-unlock') ? { sharedUnlockEnabled: false, revision: 1 } : link))
  })
  const worker = new Worker(capture, lock, () => scope, links, new SharedUnlockApi(fetcher, () => scope.apiUrl), () => { for (const listener of listeners) listener(false) })
  return { send: vi.fn(worker.dispatch.bind(worker)), subscribe: (changed: (value: boolean) => void) => { listeners.add(changed); return () => { listeners.delete(changed) } },
    lock, fetcher, sessionChanged: () => { generation++; for (const listener of listeners) listener(true) } }
}
afterEach(cleanup)
it('renders the saved link, confirms explicitly, and cancellation restores focus without a mutation', async () => {
  const f = await setup(), user = userEvent.setup(); render(<SharedUnlockLinkSettings {...f} />)
  await user.click(await screen.findByRole('button', { name: 'Disconnect' }))
  expect(screen.getByText(/extension will lock immediately/i)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('button', { name: 'Disconnect' })).toHaveFocus()
  expect(f.lock).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
})
it('uses one real worker from Popup and Side Panel and shows its new state in both hosts', async () => {
  const f = await setup(), user = userEvent.setup()
  render(<><div aria-label="popup"><SharedUnlockLinkSettings {...f} /></div><div aria-label="panel"><SharedUnlockLinkSettings {...f} /></div></>)
  const popup = within(screen.getByLabelText('popup')), panel = within(screen.getByLabelText('panel'))
  await user.click(await popup.findByRole('button', { name: 'Disconnect' }))
  await user.click(popup.getByRole('button', { name: 'Confirm' }))
  await popup.findByRole('button', { name: 'Reconnect' }); await panel.findByRole('button', { name: 'Reconnect' })
  expect(f.lock).toHaveBeenCalledOnce()
  expect(document.body.textContent).not.toContain(linkId); expect(document.body.textContent).not.toContain(scope.accountId)
})
it('failed delivery retains a visible error and the local disconnect state', async () => {
  const f = await setup(), user = userEvent.setup(); f.fetcher.mockRejectedValue(new Error('raw-secret-error'))
  render(<SharedUnlockLinkSettings {...f} />)
  await user.click(await screen.findByRole('button', { name: 'Disconnect' })); await user.click(screen.getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not finish'))
  await screen.findByRole('button', { name: 'Reconnect' }); expect(document.body.textContent).not.toContain('raw-secret-error')
})
it('reconnect explains the fresh manual unlock and works in Polish', async () => {
  const f = await setup(true), user = userEvent.setup(); render(<I18nProvider locale="pl"><SharedUnlockLinkSettings {...f} /></I18nProvider>)
  await user.click(await screen.findByRole('button', { name: 'Połącz ponownie' }))
  expect(screen.getByText(/Odblokuj je ponownie hasłem/)).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Anuluj' })); expect(f.lock).not.toHaveBeenCalled()
})
it('an own session change discards an open confirmation', async () => {
  const f = await setup(), user = userEvent.setup(); render(<SharedUnlockLinkSettings {...f} />)
  await user.click(await screen.findByRole('button', { name: 'Disconnect' }))
  await act(async () => f.sessionChanged())
  expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument(); expect(f.lock).not.toHaveBeenCalled()
})

it('confirmed reconnect clears the real worker marker and returns to saved pairing without a second account choice', async () => {
  const f = await setup(true), user = userEvent.setup(); render(<SharedUnlockLinkSettings {...f} />)
  await user.click(await screen.findByRole('button', { name: 'Reconnect' })); await user.click(screen.getByRole('button', { name: 'Confirm' }))
  await screen.findByRole('button', { name: 'Disconnect' }); expect(f.lock).toHaveBeenCalledOnce()
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})
