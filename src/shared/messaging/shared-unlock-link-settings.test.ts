import { expect, it } from 'vitest'
import { isSharedUnlockLinkSettingsCommand } from './shared-unlock-link-settings'
import { isBridgeMessage } from './index'
it('accepts only private get and explicit context-bound actions, never page bridge traffic', () => {
  for (const command of [{ type: 'shared-unlock-link/get' }, ...['disconnect', 'reconnect'].map(action => ({ type: `shared-unlock-link/${action}`, contextId: crypto.randomUUID() }))]) {
    expect(isSharedUnlockLinkSettingsCommand(command)).toBe(true); expect(isBridgeMessage(command)).toBe(false)
    for (const key of ['accountId', 'linkId', 'apiUrl', 'webOrigin', 'accessToken']) expect(isSharedUnlockLinkSettingsCommand({ ...command, [key]: 'not-authority' })).toBe(false)
  }
  expect(isSharedUnlockLinkSettingsCommand({ type: 'shared-unlock-link/disconnect' })).toBe(false)
  expect(isSharedUnlockLinkSettingsCommand({ type: 'shared-unlock-link/reconnect', contextId: '' })).toBe(false)
})
