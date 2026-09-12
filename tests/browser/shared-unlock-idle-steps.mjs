import assert from 'node:assert/strict'
import { waitForWebEntryPassword } from './native-web-entry.mjs'

const idleMs = 15 * 60_000
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Real production idle duration. No fake clocks, policy changes, key-store
// writes, direct activity messages or synthetic DOM input events.
export async function verifyIndependentIdleExpiry({ page, popup, reopenPopup, password,
  vaultId, entryId, entryPassword, countOperationResponses, setStage, recordCheck, recordRequest }) {
  setStage('independent-idle-fresh-manual-session')
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await popup.waitButton('Unlock')
  await page.locator('#unlock-password').fill(password)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  await popup.waitText('Unlocked')
  await page.getByRole('link', { name: 'Vaults', exact: true }).click()
  await page.getByText('Personal', { exact: true }).first().click()
  await page.getByText('Synthetic shared unlock proof', { exact: true }).first().click()
  await waitForWebEntryPassword(page, entryPassword)
  const entryUrl = page.url()
  // Leave the Web's final trusted input over a harmless part of its document.
  // Throttling can put the accepted last activity up to one second earlier.
  await page.mouse.move(8, 8)
  const beganAt = Date.now()
  popup = await reopenPopup()
  let moves = 0, expiredAt = null
  setStage('independent-idle-real-15-minute-wait-active-extension')
  while (Date.now() < beganAt + idleMs + 45_000) {
    await popup.trustedMouseMove()
    moves++
    assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
      'Own trusted extension activity must retain actual Entry decryption')
    if (await page.locator('#unlock-password').isVisible()) { expiredAt = Date.now(); break }
    await pause(5000)
  }
  assert(expiredAt !== null, 'Idle Web must expire despite continued peer activity')
  assert(expiredAt - beganAt >= idleMs - 2000, 'Web must not expire before its real idle duration')
  assert.equal(await page.locator('#entry-detail-password').count(), 0,
    'The expired Web must remove the decrypted Entry form')
  recordRequest({ check: 'independent-real-idle-duration', elapsedMs: expiredAt - beganAt,
    policyMs: idleMs, trustedExtensionMovements: moves })
  recordCheck('real-15-minute-web-idle-expires-while-active-extension-decrypts')
  setStage('independent-idle-expired-web-cannot-revive-from-active-peer')
  const beforeRepair = countOperationResponses()
  // Span the 15-second repair interval with no manual proof or new Web input.
  const repairUntil = Date.now() + 16_000
  while (Date.now() < repairUntil) {
    await popup.trustedMouseMove()
    assert(await page.locator('#unlock-password').isVisible(), 'Peer activity cannot revive an expired Web session')
    assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
      'Independent own Web expiry must not close the active extension')
    await pause(1000)
  }
  const repairOperations = countOperationResponses() - beforeRepair
  recordRequest({ check: 'retired-web-operation-attempts-through-repair', responses: repairOperations })
  assert(repairOperations <= 1, 'A retired own authorization must not create a repeated handoff loop')
  recordCheck('own-idle-expiry-keeps-peer-usable-and-web-locked-through-repair')
  setStage('independent-idle-reloaded-web-remains-locked')
  const beforeReload = countOperationResponses()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#unlock-password').waitFor()
  popup = await reopenPopup()
  const reloadUntil = Date.now() + 16_000
  while (Date.now() < reloadUntil) {
    assert(await page.locator('#unlock-password').isVisible(), 'Reload must not bypass the retired own idle checkpoint')
    assert.equal(await page.locator('#entry-detail-password').count(), 0)
    await pause(1000)
  }
  const reloadOperations = countOperationResponses() - beforeReload
  recordRequest({ check: 'retired-web-operation-attempts-after-reload', responses: reloadOperations })
  assert(reloadOperations <= 1, 'Reload may check a fresh channel once, not loop on the retired own authorization')
  recordCheck('reload-cannot-bypass-real-own-idle-expiry')
  setStage('independent-idle-fresh-manual-proof-restores-web')
  await page.locator('#unlock-password').fill(password)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  assert.equal(page.url(), entryUrl, 'Manual unlock must return to the original Entry')
  await waitForWebEntryPassword(page, entryPassword)
  await popup.waitText('Unlocked')
  assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword))
  recordCheck('fresh-manual-unlock-after-real-idle-restores-web-entry-decryption')
}
