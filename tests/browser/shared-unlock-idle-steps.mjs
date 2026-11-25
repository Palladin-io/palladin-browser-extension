import assert from 'node:assert/strict'
import { waitForWebEntryPassword } from './native-web-entry.mjs'

const idleMs = 15 * 60_000
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Real production idle duration. No fake clocks, policy changes, key-store
// writes, direct activity messages or synthetic DOM input events.
export async function verifyIdleParity({ page, popup, reopenPopup, password,
  vaultId, entryId, entryPassword, countOperationResponses, setStage, recordCheck, recordRequest }) {
  setStage('idle-parity-fresh-manual-session')
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await popup.waitButton('Unlock')
  await page.locator('#unlock-password').fill(password)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.locator('nav a[href="/vaults"]').waitFor()
  await popup.waitText('Unlocked')
  await page.locator('nav a[href="/vaults"]').click()
  await page.getByText('Personal', { exact: true }).first().click()
  await page.getByText('Synthetic shared unlock proof', { exact: true }).first().click()
  await waitForWebEntryPassword(page, entryPassword)
  const entryUrl = page.url()
  // Leave the Web's final trusted input over a harmless part of its document.
  // Throttling can put the accepted last activity up to one second earlier.
  await page.mouse.move(8, 8)
  const beganAt = Date.now()
  popup = await reopenPopup()
  let moves = 0, relocks = 0, wasLocked = false
  const observe = async until => {
    while (Date.now() < until) {
      await popup.trustedMouseMove()
      moves++
      assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
        'Own trusted extension activity must retain actual Entry decryption')
      const locked = await page.locator('#unlock-password').isVisible()
      if (locked && !wasLocked) relocks++
      wasLocked = locked
      await pause(1000)
    }
  }
  setStage('idle-parity-real-15-minute-wait-active-extension')
  const before = countOperationResponses()
  await observe(beganAt + idleMs + 45_000)
  await page.locator('nav a[href="/vaults"]').waitFor({ timeout: 30_000 })
  assert(countOperationResponses() > before, 'A live extension must hand its authorization back after Web idle')
  recordRequest({ check: 'idle-parity-real-duration', policyMs: idleMs, trustedExtensionMovements: moves, observedRelocks: relocks })
  recordCheck('real-15-minute-web-idle-is-restored-by-live-extension')

  setStage('idle-parity-reopened-after-idle')
  await page.goto('about:blank')
  await observe(Date.now() + idleMs + 60_000)
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded' })
  await waitForWebEntryPassword(page, entryPassword)
  recordCheck('panel-closed-longer-than-idle-reopens-unlocked')

  setStage('idle-parity-steady')
  const steady = countOperationResponses()
  await pause(32_000)
  assert.equal(countOperationResponses(), steady, 'A completed handoff must not repeat')
  recordCheck('idle-parity-has-no-steady-handoff-loop')

  setStage('idle-parity-manual-lock-remains-terminal')
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await popup.waitButton('Unlock')
  await pause(32_000)
  assert(await page.locator('#unlock-password').isVisible(), 'Manual lock must not be undone by the peer')
  recordCheck('manual-lock-after-idle-parity-remains-locked')
  await page.locator('#unlock-password').fill(password)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.locator('nav a[href="/vaults"]').waitFor()
  await popup.waitText('Unlocked')
}
