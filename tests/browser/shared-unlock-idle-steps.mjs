import assert from 'node:assert/strict'
import { waitForWebEntryPassword } from './native-web-entry.mjs'

const idleMs = 15 * 60_000
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Real production idle duration. No fake clocks, policy changes, key-store
// writes, direct activity messages or synthetic DOM input events.
export async function verifyIndependentIdleExpiry({ page, popup, reopenPopup, password,
  vaultId, entryId, entryPassword, countOperationResponses, cleanupStatuses, setStage, recordCheck, recordRequest }) {
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
  const observe = async duration => {
    const until = Date.now() + duration
    let nextMovement = 0
    while (Date.now() < until) {
      if (Date.now() >= nextMovement) { await popup.trustedMouseMove(); nextMovement = Date.now() + 5000 }
      assert(await page.locator('#unlock-password').isVisible(), 'Peer activity cannot revive an expired Web session')
      assert.equal(await page.locator('#entry-detail-password').count(), 0)
      assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
        'Independent own Web expiry and cleanup must preserve the active extension')
      await pause(1000)
    }
  }
  const stableDenial = async (label, before) => {
    setStage(label + '-initial-observation')
    // The first authenticated preference observation can reset selection once.
    // Later unchanged preference repair must never retry this denied handoff.
    await observe(16_000)
    const initialized = countOperationResponses()
    recordRequest({ check: label + '-initial-operations', responses: initialized - before })
    assert(initialized - before <= 2, 'Initial admission cannot create a handoff storm')
    setStage(label + '-steady-repair')
    await observe(32_000)
    recordRequest({ check: label + '-steady-operations', responses: countOperationResponses() - initialized })
    assert.equal(countOperationResponses(), initialized,
      'Unchanged repair and peer activity must not restart a denied expired receiver')
  }
  const cleanupBefore = cleanupStatuses().length
  await stableDenial('independent-idle-expired-web', countOperationResponses())
  recordCheck('own-idle-expiry-keeps-peer-usable-and-web-locked-with-no-steady-retry')
  setStage('independent-idle-reloaded-web-remains-locked')
  const beforeReload = countOperationResponses()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#unlock-password').waitFor()
  popup = await reopenPopup()
  await stableDenial('independent-idle-reloaded-web', beforeReload)
  recordCheck('reload-cannot-bypass-real-own-idle-expiry-or-retry-through-repair')
  const cleanup = cleanupStatuses().slice(cleanupBefore)
  recordRequest({ check: 'real-idle-rejected-issued-session-cleanup', statuses: cleanup })
  assert(cleanup.length > 0, 'A rejected expired receiver session must reach real cleanup')
  assert(cleanup.every(status => status === 204), 'Identity must authorize and finish rejected own-session cleanup')
  recordCheck('real-idle-rejected-own-sessions-revoked-without-closing-peer')
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
