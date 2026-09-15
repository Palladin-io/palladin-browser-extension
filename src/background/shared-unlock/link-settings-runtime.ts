import type { SharedUnlockLinkSettingsCommand } from '../../shared/messaging/shared-unlock-link-settings'
import { sharedUnlockSettingsChanged } from '../../shared/messaging/shared-unlock-settings'
import { initializeServerConfig, serverConfig } from '../config/server-runtime'
import { sessionManager, sharedUnlockLinks } from '../session/runtime'
import { SharedUnlockApi } from './api'
import { SharedUnlockLinkSettings } from './link-settings'

const settings = new SharedUnlockLinkSettings(
  () => sessionManager.captureSharedUnlockSettingsSession(),
  source => sessionManager.lockSharedUnlockSettingsSession(source),
  session => {
    const environment = __PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__.find(value => value.apiUrl === session.apiUrl)
    return environment ? { ...environment, accountId: session.userId, extensionId: chrome.runtime.id } : null
  },
  sharedUnlockLinks,
  new SharedUnlockApi((...args) => fetch(...args), () => serverConfig.apiUrl),
  () => { void chrome.runtime.sendMessage(sharedUnlockSettingsChanged()).catch(() => {}) },
)
export function handleSharedUnlockLinkSettings(command: SharedUnlockLinkSettingsCommand) {
  if (command.type !== 'shared-unlock-link/get') return settings.dispatch(command)
  return initializeServerConfig().then(() => settings.dispatch(command))
}
