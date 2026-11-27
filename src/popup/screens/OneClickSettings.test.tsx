// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ONE_CLICK_DISABLED_KEY, ONE_CLICK_MUTED_KEY } from '@shared/config/one-click-preferences'
import { OneClickSettings } from './OneClickSettings'

function memoryStorage(initial: Record<string, unknown>) {
  const items: Record<string, unknown> = { ...initial }
  return {
    items,
    get: async (keys: string[]) => Object.fromEntries(keys.filter(key => key in items).map(key => [key, items[key]])),
    set: async (values: Record<string, unknown>) => { Object.assign(items, values) },
  }
}

describe('one-click sign-in settings', () => {
  it('turns the suggestion off and on for every site', async () => {
    const storage = memoryStorage({})
    render(<OneClickSettings storage={storage} />)
    const user = userEvent.setup()
    const toggle = await screen.findByRole('switch', { name: 'Show the sign-in suggestion' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(storage.items[ONE_CLICK_DISABLED_KEY]).toBe(true)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(storage.items[ONE_CLICK_DISABLED_KEY]).toBe(false)
  })

  it('reenables the suggestion on a site the user chose never to show it', async () => {
    const storage = memoryStorage({ [ONE_CLICK_MUTED_KEY]: ['x.com', 'allegro.pl', 42] })
    render(<OneClickSettings storage={storage} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Remove x.com from ignored sites' }))
    expect(storage.items[ONE_CLICK_MUTED_KEY]).toEqual(['allegro.pl'])
    expect(screen.queryByText('x.com')).not.toBeInTheDocument()
    expect(screen.getByText('allegro.pl')).toBeInTheDocument()
  })

  it('undoes turning a site back on for a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const storage = memoryStorage({ [ONE_CLICK_MUTED_KEY]: ['x.com', 'allegro.pl'] })
      render(<OneClickSettings storage={storage} />)
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      await user.click(await screen.findByRole('button', { name: 'Remove x.com from ignored sites' }))
      expect(screen.getByRole('status')).toHaveTextContent('Removed x.com')
      await user.click(screen.getByRole('button', { name: 'Undo' }))
      expect(storage.items[ONE_CLICK_MUTED_KEY]).toEqual(['x.com', 'allegro.pl'])
      expect(screen.getByText('x.com')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Remove allegro.pl from ignored sites' }))
      await act(() => vi.advanceTimersByTimeAsync(6000))
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
      expect(storage.items[ONE_CLICK_MUTED_KEY]).toEqual(['x.com'])
    } finally { vi.useRealTimers() }
  })

  it('shows an empty list when no site is turned off', async () => {
    render(<OneClickSettings storage={memoryStorage({})} />)
    expect(await screen.findByText('None')).toBeInTheDocument()
  })
})

describe('ignored site icons', () => {
  it('uses the icon of the saved Entry for that site and a key otherwise', async () => {
    const { OneClickSiteEntries } = await import('./OneClickSettings')
    const storage = memoryStorage({ [ONE_CLICK_MUTED_KEY]: ['login.example.com', 'other.test'] })
    const entries = [{ id: 'e1', vaultId: 'v1', vaultName: 'Personal', name: 'Example', type: 1, urlDomain: 'example.com',
      icon: 'globe', color: '#2563eb', updatedAt: '2026-11-26T00:00:00Z' }] as never
    const { container } = render(<OneClickSiteEntries.Provider value={entries}><OneClickSettings storage={storage} /></OneClickSiteEntries.Provider>)
    await screen.findByText('other.test')
    const icons = [...container.querySelectorAll<HTMLElement>('.one-click-site .entry-icon')]
    expect(icons.map((icon) => icon.style.color)).toEqual(['rgb(37, 99, 235)', ''])
  })
})
