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
    render(<UpdateNotice deps={d} fallback={<span>Version 0.1.15</span>} />)
    expect(d.checkForUpdate).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(screen.getByText('Version 0.1.15')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('offers the downloaded version and applies it on click', async () => {
    const d = deps('0.1.17')
    render(<UpdateNotice deps={d} fallback={<span>Version 0.1.15</span>} />)
    expect(await screen.findByRole('button', { name: 'Update to 0.1.17' })).toBeInTheDocument()
    expect(screen.queryByText('Version 0.1.15')).toBeNull()
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
