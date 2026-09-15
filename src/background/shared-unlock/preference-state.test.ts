import { expect, it, vi } from 'vitest'
import { SharedUnlockPreferenceState } from './preference-state'

const scope = { accountId: 'own-account', apiUrl: 'https://api.test' }
it('coalesces duplicate and older own responses without re-enabling an observed OFF', () => {
  const state = new SharedUnlockPreferenceState(), changed = vi.fn(), saved = vi.fn()
  state.subscribe(changed); state.subscribeSaved(saved)
  state.observe(scope, { sharedUnlockEnabled: false, revision: 3 })
  state.observe(scope, { sharedUnlockEnabled: true, revision: 2 })
  state.observe(scope, { sharedUnlockEnabled: false, revision: 3 })
  expect(() => state.assertNotDisabled(scope)).toThrow(); expect(changed).toHaveBeenCalledOnce()
  expect(saved).not.toHaveBeenCalled()
  state.observe(scope, { sharedUnlockEnabled: true, revision: 4 })
  state.assertNotDisabled(scope); expect(changed).toHaveBeenCalledTimes(2)
})
it('isolates account/API observations and removes them with the own session', () => {
  const state = new SharedUnlockPreferenceState()
  state.observe(scope, { sharedUnlockEnabled: false, revision: 3 })
  state.assertNotDisabled({ ...scope, accountId: 'another-account' })
  state.assertNotDisabled({ ...scope, apiUrl: 'https://other.test' })
  state.clear(); state.assertNotDisabled(scope)
})
