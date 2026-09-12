import assert from 'node:assert/strict'
import { waitForWebEntryPassword } from './native-web-entry.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// A real OFF -> own manual Lock -> peer ON sequence retires Web's own
// authorization without closing the Extension. No clock/store/key injection.
export async function verifyRetiredWebReceiver({ page, popup, reopenPopup, apiUrl,
  password, vaultId, entryId, entryPassword, countOperations, cleanupStatuses,
  setStage, recordCheck, recordRequest }) {
  const switchName = { name: 'Shared unlock', exact: true }
  setStage('retired-receiver-web-off-and-own-manual-lock')
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('link', { name: 'Security', exact: true }).click()
  await popup.click('Settings'); await popup.click('Shared unlock')
  const off = page.waitForResponse(r => r.url() === apiUrl + '/api/account/shared-unlock' && r.request().method() === 'PUT')
  await page.getByRole('switch', { ...switchName, checked: true }).click()
  assert.equal((await off).status(), 200)
  await popup.waitSwitch('Shared unlock', false)
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await page.locator('#unlock-password').waitFor()
  assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword))
  await popup.click('Shared unlock', 'switch'); await popup.waitSwitch('Shared unlock', true)
  await popup.click('Back')
  recordCheck('real-off-own-lock-peer-on-retains-extension-and-retires-web')

  const observe = async duration => {
    const until = Date.now() + duration
    let nextMovement = 0
    while (Date.now() < until) {
      if (Date.now() >= nextMovement) { await popup.trustedMouseMove(); nextMovement = Date.now() + 5000 }
      assert(await page.locator('#unlock-password').isVisible(), 'A retired Web session cannot be restored by peer activity')
      assert.equal(await page.locator('#entry-detail-password').count(), 0)
      assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword), 'Own cleanup must preserve the active Extension')
      await pause(1000)
    }
  }
  const stableDenial = async label => {
    setStage(label + '-initial-observation')
    const before = countOperations()
    // Initial authenticated preference observation can change the selection
    // once after page startup. Every later unchanged repair must remain quiet.
    await observe(16_000)
    const initialized = countOperations()
    recordRequest({ check: label + '-initial-operations', count: initialized - before })
    assert(initialized - before <= 2, 'Initial admission cannot create a handoff storm')
    setStage(label + '-steady-repair')
    await observe(32_000)
    recordRequest({ check: label + '-steady-operations', count: countOperations() - initialized })
    assert.equal(countOperations(), initialized, 'Unchanged own preference repair and peer activity must not restart a denied handoff')
  }
  const cleanupBefore = cleanupStatuses().length
  await stableDenial('retired-receiver-existing-document')
  recordCheck('retired-own-web-denial-remains-stable-with-active-peer')
  setStage('retired-receiver-reload')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#unlock-password').waitFor()
  popup = await reopenPopup()
  await stableDenial('retired-receiver-new-document')
  recordCheck('retired-web-reload-has-bounded-initialization-and-no-steady-retry')
  const cleanup = cleanupStatuses().slice(cleanupBefore)
  recordRequest({ check: 'retired-receiver-issued-session-cleanup', statuses: cleanup })
  assert(cleanup.length > 0, 'At least one rejected own receiver session must reach real cleanup')
  assert(cleanup.every(status => status === 204), 'Identity must authorize and complete rejected own-session cleanup')
  recordCheck('rejected-own-receiver-sessions-revoked-without-closing-peer')

  setStage('retired-receiver-new-manual-generation')
  await page.locator('#unlock-password').fill(password)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.getByRole('link', { name: 'Vaults', exact: true }).click()
  await page.getByText('Personal', { exact: true }).first().click()
  await page.getByText('Synthetic shared unlock proof', { exact: true }).first().click()
  await waitForWebEntryPassword(page, entryPassword)
  assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword))
  recordCheck('fresh-manual-generation-after-retirement-restores-own-web-entry')
}
