import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  keys: {} as object | null, server: { apiUrl: 'https://api.example.test' },
  getUserId: vi.fn(), getMetadata: vi.fn(), getProfile: vi.fn(), disableAutomatic: vi.fn(), unmute: vi.fn(),
}))
vi.mock('../session/runtime', () => ({ sessionManager: { getKeys: () => mocks.keys, getUserId: mocks.getUserId } }))
vi.mock('../config/server-runtime', () => ({ serverConfig: mocks.server }))
vi.mock('../vault/runtime', () => ({ vaultData: { getMetadata: mocks.getMetadata } }))
vi.mock('./preferences-runtime', () => ({ capturePreferences: {
  getProfile: mocks.getProfile, disableAutomatic: mocks.disableAutomatic, unmute: mocks.unmute,
} }))

import { handleCaptureSettings } from './settings-runtime'

describe('capture settings session boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.keys = {}
    mocks.server.apiUrl = 'https://api.example.test'
    mocks.getUserId.mockResolvedValue('account')
    mocks.getMetadata.mockResolvedValue([{ id: 'entry', vaultId: 'vault', name: 'Private login', vaultName: 'Personal' }])
    mocks.getProfile.mockResolvedValue({ mutedSites: [], automaticUpdates: [
      { entryId: 'entry', vaultId: 'vault', origin: 'https://login.example.test', revision: '1' },
    ] })
  })

  it('returns labels only for the current unlocked profile', async () => {
    expect(await handleCaptureSettings({ type: 'capture-settings/get' })).toEqual({ ok: true, mutedSites: [],
      automaticUpdates: [{ entryId: 'entry', vaultId: 'vault', origin: 'https://login.example.test',
        label: 'Private login', vaultLabel: 'Personal' }] })
    expect(mocks.getProfile).toHaveBeenCalledWith('https://api.example.test:account')
  })

  it.each(['lock', 'new-session', 'server-change'])('discards labels after %s during the read', async (change) => {
    mocks.getMetadata.mockImplementation(async () => {
      if (change === 'lock') mocks.keys = null
      if (change === 'new-session') mocks.keys = {}
      if (change === 'server-change') mocks.server.apiUrl = 'https://other.example.test'
      return [{ id: 'entry', vaultId: 'vault', name: 'Private login' }]
    })
    expect(await handleCaptureSettings({ type: 'capture-settings/get' })).toEqual({ ok: false })
  })

  it('does not change preferences when the session changes during account lookup', async () => {
    mocks.getUserId.mockImplementation(async () => { mocks.keys = {}; return 'account' })
    expect(await handleCaptureSettings({ type: 'capture-settings/disable', vaultId: 'vault', entryId: 'entry' }))
      .toEqual({ ok: false })
    expect(mocks.disableAutomatic).not.toHaveBeenCalled()
  })
})
