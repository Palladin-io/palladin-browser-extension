import type { CaptureSettingsCommand, CaptureSettingsResult } from '@shared/messaging/capture-settings'
import { serverConfig } from '../config/server-runtime'
import { sessionManager } from '../session/runtime'
import { vaultData } from '../vault/runtime'
import { capturePreferences } from './preferences-runtime'

export async function handleCaptureSettings(command: CaptureSettingsCommand): Promise<CaptureSettingsResult> {
  const keys = sessionManager.getKeys()
  const apiUrl = serverConfig.apiUrl
  if (!keys) return { ok: false }
  const isCurrent = () => sessionManager.getKeys() === keys && serverConfig.apiUrl === apiUrl
  const userId = await sessionManager.getUserId()
  if (!userId || !isCurrent()) return { ok: false }
  const profileId = `${apiUrl}:${userId}`
  try {
    if (command.type === 'capture-settings/disable') {
      await capturePreferences.disableAutomatic(profileId, command.vaultId, command.entryId)
    } else if (command.type === 'capture-settings/unmute') {
      await capturePreferences.unmute(profileId, command.site)
    }
    const [preferences, entries] = await Promise.all([capturePreferences.getProfile(profileId), vaultData.getMetadata()])
    if (!isCurrent()) return { ok: false }
    return { ok: true, mutedSites: preferences.mutedSites, automaticUpdates: preferences.automaticUpdates.map((binding) => {
      const entry = entries.find((candidate) => candidate.id === binding.entryId && candidate.vaultId === binding.vaultId)
      return { vaultId: binding.vaultId, entryId: binding.entryId, origin: binding.origin,
        label: entry?.name ?? `${binding.entryId.slice(0, 8)}…${binding.entryId.slice(-6)}`, vaultLabel: entry?.vaultName ?? '' }
    }) }
  } catch { return { ok: false } }
}
