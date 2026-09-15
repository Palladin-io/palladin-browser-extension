import { sharedUnlockSettingsChanged, type SharedUnlockSettingsCommand } from '../../shared/messaging/shared-unlock-settings'
import { initializeServerConfig, serverConfig } from '../config/server-runtime'
import { sessionManager, sharedUnlockPreferenceGate, sharedUnlockSource } from '../session/runtime'
import { SharedUnlockApi } from './api'
import { SharedUnlockSettings } from './settings'
import { sharedUnlockPreferences } from './preference-state-runtime'

sharedUnlockPreferences.subscribe(() => { void chrome.runtime.sendMessage(sharedUnlockSettingsChanged()).catch(() => {}) })

const settings = new SharedUnlockSettings(
  () => sessionManager.captureSharedUnlockSettingsSession(),
  new SharedUnlockApi((...args) => fetch(...args), () => serverConfig.apiUrl),
  sharedUnlockPreferenceGate,
  (session, preference) => {
    const current = sharedUnlockSource.snapshot()
    if (current.authorization?.accountId === session.userId && current.sourceGeneration) {
      sharedUnlockSource.acceptPreference(preference, current.sourceGeneration)
    }
    sharedUnlockPreferences.observe({ accountId: session.userId, apiUrl: session.apiUrl }, preference)
  },
  () => { void chrome.runtime.sendMessage(sharedUnlockSettingsChanged()).catch(() => {}) },
  scope => sharedUnlockPreferences.saved(scope),
)

export function handleSharedUnlockSettings(command: SharedUnlockSettingsCommand) {
  // A set can only use the context issued after an initialized get. Do not yield
  // before its local pause; the caller already holds the server-operation lease.
  if (command.type === 'shared-unlock-settings/set') return settings.dispatch(command)
  return initializeServerConfig().then(() => settings.dispatch(command))
}
