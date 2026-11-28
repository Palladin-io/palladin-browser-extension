// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { UpdateNotice, type UpdateNoticeDeps } from './UpdateNotice'

function deps(ready: unknown, current = '0.1.15') {
  let listener: (value: unknown) => void = () => undefined
  const value: UpdateNoticeDeps & { emit(version: unknown): void } = {
    current,
    readReady: async () => ready,
    onReadyChanged: (next) => { listener = next; return () => undefined },
    checkForUpdate: vi.fn(),
    applyUpdate: vi.fn(),
    emit: (version) => listener(version),
  }
  return value
}

describe('update notice', () => {
  it('asks Chrome for an update and stays hidden until one is downloaded', async () => {
    const d = deps(undefined)
    const { container } = render(<UpdateNotice deps={d} />)
    expect(d.checkForUpdate).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
  })
  it('offers the downloaded version and applies it on click', async () => {
    const d = deps('0.1.17')
    render(<UpdateNotice deps={d} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Update to 0.1.17' }))
    expect(d.applyUpdate).toHaveBeenCalledOnce()
  })
  it('appears when the worker reports a download while the popup is open, never for the running version', async () => {
    const d = deps('0.1.15')
    render(<UpdateNotice deps={d} />)
    await Promise.resolve()
    expect(screen.queryByRole('button')).toBeNull()
    d.emit('0.1.18')
    expect(await screen.findByRole('button', { name: 'Update to 0.1.18' })).toBeInTheDocument()
  })
})
