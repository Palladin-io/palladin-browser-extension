import assert from 'node:assert/strict'
import { waitForWebEntryPassword } from './native-web-entry.mjs'

// The panel is opened by the product's native popup button, not a tab at its URL.
export async function verifySharedUnlockSidePanel({ page, popup, attachPanel,
  password, vaultId, entryId, entryPassword, setStage, recordCheck }) {
  setStage('side-panel-opened-by-trusted-native-popup-click')
  await popup.click('Open side panel')
  const panel = await attachPanel()
  try {
    await panel.waitText('Unlocked')
    assert(await panel.revealedFieldMatches(vaultId, entryId, 'password', entryPassword))
    recordCheck('browser-owned-side-panel-opens-and-decrypts-actual-entry')

    setStage('web-manual-lock-reaches-native-side-panel')
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await page.locator('#unlock-password').waitFor()
    await panel.waitButton('Unlock')
    assert(await panel.revealDeniedWhileLocked(vaultId, entryId))
    recordCheck('web-lock-removes-native-side-panel-entry-access')

    setStage('side-panel-manual-unlock-restores-web')
    await panel.fill('input[type="password"]', password)
    await panel.click('Unlock')
    await panel.waitText('Unlocked')
    await page.getByRole('link', { name: 'Vaults', exact: true }).click()
    await page.getByText('Personal', { exact: true }).first().click()
    await page.getByText('Synthetic shared unlock proof', { exact: true }).first().click()
    await waitForWebEntryPassword(page, entryPassword)
    assert(await panel.revealedFieldMatches(vaultId, entryId, 'password', entryPassword))
    recordCheck('native-side-panel-manual-unlock-restores-web-entry')

    setStage('side-panel-manual-lock-reaches-web')
    await panel.click('Lock')
    await page.locator('#unlock-password').waitFor()
    await panel.waitButton('Unlock')
    assert(await panel.revealDeniedWhileLocked(vaultId, entryId))
    assert.equal(await page.locator('#entry-detail-password').count(), 0)
    recordCheck('native-side-panel-lock-removes-web-entry-access')

    setStage('web-manual-unlock-restores-native-side-panel')
    await page.locator('#unlock-password').fill(password)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await panel.waitText('Unlocked')
    await waitForWebEntryPassword(page, entryPassword)
    assert(await panel.revealedFieldMatches(vaultId, entryId, 'password', entryPassword))
    recordCheck('web-manual-unlock-restores-native-side-panel-entry')
    return panel
  } catch (error) { panel.close(); throw error }
}
