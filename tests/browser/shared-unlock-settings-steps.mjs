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
    await popup.click('Settings'); await popup.click('Shared unlock')
  }
  const reveal = async () => assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
    'The actual synthetic Entry must remain decryptable')
  const denyPeer = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'The actual peer Entry must remain denied')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  const unlockWeb = async () => {
    await page.locator('#unlock-password').fill(password)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  }
  const unlockExtension = async () => {
    await popup.waitButton('Unlock')
    await popup.fill('input[autocomplete="current-password"]', password)
    await popup.click('Unlock'); await popup.waitText('Unlocked')
  }
  const confirmWeb = async (label, cancel = false) => {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.getByRole('dialog', { name: label, exact: true })
      .getByRole('button', { name: cancel ? 'Cancel' : label, exact: true }).click()
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

  setStage('settings-web-disconnect-cancel-preserves-pairing')
  await confirmWeb('Disconnect this browser', true)
  await reveal()
  recordCheck('cancel-web-disconnect-preserves-live-entry-access')

  setStage('settings-web-disconnect-locks-both-clients')
  await confirmWeb('Disconnect this browser')
  await page.locator('#unlock-password').waitFor()
  await popup.waitButton('Unlock'); await denyPeer()
  recordCheck('confirmed-web-disconnect-locks-both-and-denies-entry')

  setStage('settings-disconnected-manual-unlock-cannot-relink')
  await unlockWeb(); await webSettings()
  await waitWebSwitch(true)
  await page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor()
  await denyPeer()
  recordCheck('disconnected-web-stays-local-after-manual-unlock-and-navigation')

  setStage('settings-web-reconnect-needs-fresh-unlock')
  await confirmWeb('Reconnect', true); await denyPeer()
  await confirmWeb('Reconnect')
  await page.locator('#unlock-password').waitFor(); await denyPeer()
  await unlockWeb(); await popup.waitText('Unlocked'); await reveal()
  recordCheck('explicit-web-reconnect-requires-fresh-unlock-and-restores-peer')

  setStage('settings-extension-disconnect-cancel-and-confirm')
  await extensionSettings(); await popup.waitSwitch('Shared unlock', true)
  await popup.click('Disconnect'); await popup.click('Cancel'); await reveal()
  recordCheck('cancel-extension-disconnect-preserves-live-entry-access')
  await popup.click('Disconnect'); await popup.click('Confirm')
  await popup.click('Back')
  await popup.waitButton('Unlock'); await page.locator('#unlock-password').waitFor(); await denyPeer()
  recordCheck('confirmed-extension-disconnect-locks-both-and-denies-entry')

  setStage('settings-extension-disconnected-unlock-stays-local')
  await unlockExtension(); await reveal()
  for (let attempt = 0; attempt < 6; attempt++) {
    assert(await page.locator('#unlock-password').isVisible(), 'Disconnected extension must not unlock Web')
    await reveal()
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  await extensionSettings(); await popup.waitSwitch('Shared unlock', true)
  await popup.waitButton('Reconnect')
  recordCheck('disconnected-extension-stays-local-and-preserves-account-on')

  setStage('settings-extension-reconnect-needs-fresh-unlock')
  await popup.click('Reconnect'); await popup.click('Cancel'); await reveal()
  setStage('settings-extension-confirmed-reconnect-keeps-both-locked')
  await popup.click('Reconnect'); await popup.click('Confirm'); await popup.click('Back')
  await popup.waitButton('Unlock'); await denyPeer()
  assert(await page.locator('#unlock-password').isVisible(), 'Reconnect alone cannot unlock Web')
  setStage('settings-extension-fresh-unlock-restores-web')
  await unlockExtension(); await reveal()
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  recordCheck('explicit-extension-reconnect-requires-fresh-unlock-and-restores-web')
}
