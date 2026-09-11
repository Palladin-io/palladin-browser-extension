import { describe, expect, it } from 'vitest'
import { isBridgeMessage } from './index'
import { isSharedUnlockSettingsChanged, isSharedUnlockSettingsCommand } from './shared-unlock-settings'

const set = { type: 'shared-unlock-settings/set', contextId: '11111111-1111-4111-8111-111111111111', enabled: false, revision: 3 }
describe('private shared unlock settings messages', () => {
  it('accepts the two strict worker commands but never page bridge traffic', () => {
    for (const command of [{ type: 'shared-unlock-settings/get' }, set]) {
      expect(isSharedUnlockSettingsCommand(command)).toBe(true)
      expect(isBridgeMessage(command)).toBe(false)
    }
  })
  it.each([{ ...set, accountId: 'other' }, { ...set, accessToken: 'synthetic-token' }, { ...set, apiUrl: 'https://other.test' },
    { ...set, revision: 1.5 }, { ...set, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...set, enabled: 'false' },
    { ...set, contextId: '' }, { type: 'shared-unlock-settings/get', enabled: true }, null, []])('rejects malformed or substituted authority', raw => {
    expect(isSharedUnlockSettingsCommand(raw)).toBe(false)
  })
  it('accepts only value-free invalidation hints', () => {
    expect(isSharedUnlockSettingsChanged({ type: 'shared-unlock-settings/changed' })).toBe(true)
    expect(isSharedUnlockSettingsChanged({ type: 'shared-unlock-settings/changed', enabled: true })).toBe(false)
    expect(isSharedUnlockSettingsCommand({ type: 'shared-unlock-settings/changed' })).toBe(false)
  })
})
