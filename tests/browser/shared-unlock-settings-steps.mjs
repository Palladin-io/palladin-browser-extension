import assert from 'node:assert/strict'

// All writes use real Web/native-popup controls. Only value-free checks leave
// the synthetic clients; private Entry reads are compared inside the popup.
export async function verifySharedUnlockSettings({ page, popup, apiUrl,
  password, vaultId, entryId, entryPassword, setStage, recordCheck }) {
  const webSwitch = () => page.getByRole('switch', { name: 'Shared unlock', exact: true })
  const waitWebSwitch = async checked => {
    await page.getByRole('switch', { name: 'Shared unlock', exact: true, checked }).waitFor()
  }
  const webSettings = async () => {
    // A full document navigation deliberately wipes keys; OFF/disconnected
    // clients must reach settings through the same SPA navigation as the user.
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('link', { name: 'Security', exact: true }).click()
    await webSwitch().waitFor()
  }
  const extensionSettings = async () => {
    await popup.click('Settings')
  }
  const reveal = async () => assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
    'The actual synthetic Entry must remain decryptable')
  const unlockWeb = async () => {
    await page.locator('#unlock-password').fill(password)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  }
  setStage('settings-default-on-both-clients')
  await webSettings(); await extensionSettings()
  await waitWebSwitch(true); await popup.waitSwitch('Shared unlock', true)
  recordCheck('actual-shared-unlock-settings-default-on-in-both-clients')

  setStage('settings-web-off-propagates-and-preserves-own-sessions')
  const off = page.waitForResponse(r => r.url() === apiUrl + '/api/account/shared-unlock'
    && r.request().method() === 'PUT')
  await webSwitch().click()
  assert.equal((await off).status(), 200, 'Identity must persist the actual Web OFF choice')
  await waitWebSwitch(false); await popup.waitSwitch('Shared unlock', false)
  await reveal()
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  recordCheck('web-off-updates-extension-with-existing-sessions-preserved')

  setStage('settings-off-does-not-propagate-lock-or-reopen-unlock')
  await popup.click('Back')
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await page.locator('#unlock-password').waitFor()
  await page.reload()
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.locator('#unlock-password').waitFor()
    await reveal()
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  recordCheck('off-keeps-peer-unlocked-and-reopened-web-locked')
  setStage('settings-manual-unlock-preserves-off')
  await unlockWeb(); await webSettings(); await extensionSettings()
  await waitWebSwitch(false); await popup.waitSwitch('Shared unlock', false)
  recordCheck('manual-unlock-and-document-reload-preserve-account-off')

  setStage('settings-extension-on-propagates-to-web')
  await popup.click('Shared unlock', 'switch')
  await popup.waitSwitch('Shared unlock', true); await waitWebSwitch(true)
  await reveal(); await popup.click('Back')
  recordCheck('extension-on-updates-web-without-changing-own-session')

}
