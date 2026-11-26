// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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
    await user.click(await screen.findByRole('button', { name: 'Turn off one-click sign-in' }))
    expect(storage.items[ONE_CLICK_DISABLED_KEY]).toBe(true)
    await user.click(await screen.findByRole('button', { name: 'Turn on one-click sign-in' }))
    expect(storage.items[ONE_CLICK_DISABLED_KEY]).toBe(false)
  })

  it('reenables the suggestion on a site the user chose never to show it', async () => {
    const storage = memoryStorage({ [ONE_CLICK_MUTED_KEY]: ['x.com', 'allegro.pl', 42] })
    render(<OneClickSettings storage={storage} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Turn on one-click sign-in on x.com' }))
    expect(storage.items[ONE_CLICK_MUTED_KEY]).toEqual(['allegro.pl'])
    expect(screen.queryByText('x.com')).not.toBeInTheDocument()
    expect(screen.getByText('allegro.pl')).toBeInTheDocument()
  })

  it('shows an empty list when no site is turned off', async () => {
    render(<OneClickSettings storage={memoryStorage({})} />)
    expect(await screen.findByText('None')).toBeInTheDocument()
  })
})
