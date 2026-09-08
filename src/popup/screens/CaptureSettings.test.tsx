// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CaptureSettings } from './CaptureSettings'

const settings = { ok: true as const, mutedSites: ['example.com'], automaticUpdates: [
  { vaultId: 'vault-1234567890123', entryId: 'entry-1234567890123', label: 'Alice', vaultLabel: 'Personal', origin: 'https://example.com' },
] }

describe('capture account and site settings', () => {
  it('renders current settings and disables only the selected account', async () => {
    const send = vi.fn().mockResolvedValueOnce(settings).mockResolvedValue({ ...settings, automaticUpdates: [] })
    render(<CaptureSettings send={send} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Turn off automatic updates for Alice' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'capture-settings/disable', vaultId: settings.automaticUpdates[0]!.vaultId,
      entryId: settings.automaticUpdates[0]!.entryId })
    expect(await screen.findByText('No accounts have automatic updates enabled.')).toBeInTheDocument()
  })
  it('reenables save suggestions on a muted site', async () => {
    const send = vi.fn().mockResolvedValueOnce(settings).mockResolvedValue({ ...settings, mutedSites: [] })
    render(<CaptureSettings send={send} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Enable save suggestions on example.com' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'capture-settings/unmute', site: 'example.com' })
    expect(await screen.findByText('Save suggestions are enabled on all sites.')).toBeInTheDocument()
  })
  it('preserves the account control and shows an error when the update fails', async () => {
    const send = vi.fn().mockResolvedValueOnce(settings).mockResolvedValue({ ok: false })
    render(<CaptureSettings send={send} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Turn off automatic updates for Alice' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load or change settings.')
    expect(screen.getByRole('button', { name: 'Turn off automatic updates for Alice' })).toBeEnabled()
  })
})
