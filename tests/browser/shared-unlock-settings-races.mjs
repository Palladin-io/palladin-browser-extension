import assert from 'node:assert/strict'

// Faults change transport timing/delivery only. Identity produces the actual
// conflict response; no preference/session/key state is injected into either app.
export async function verifySharedUnlockSettingsRaces({ page, popup, reopenPopup, apiUrl, webOrigin,
  vaultId, entryId, entryPassword, setStage, recordCheck }) {
  const endpoint = apiUrl + '/api/account/shared-unlock'
  const toggle = () => page.getByRole('switch', { name: 'Shared unlock', exact: true })
  const waitWeb = checked => page.getByRole('switch', { name: 'Shared unlock', exact: true, checked }).waitFor()
  const writeResponse = () => page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'PUT')
  const reveal = async () => assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
    'A paused preference write must preserve the existing independent Entry session')
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('link', { name: 'Security', exact: true }).click()
  await popup.click('Settings'); await popup.click('Shared unlock')
  await waitWeb(true); await popup.waitSwitch('Shared unlock', true)

  setStage('settings-failed-off-keeps-account-on-and-local-pause')
  const abortWrite = route => route.request().method() === 'PUT' ? route.abort('failed') : route.fallback()
  await page.route(endpoint, abortWrite)
  try {
    await toggle().click()
    await page.getByText('The save did not finish. Synchronization remains locally paused. Retry to save your choice.', { exact: true }).waitFor()
  } finally { await page.unroute(endpoint, abortWrite) }
  await waitWeb(true); await popup.waitSwitch('Shared unlock', true); await reveal()
  setStage('settings-failed-off-new-document-cannot-unlock')
  const probe = await page.context().newPage()
  try {
    await probe.goto(webOrigin + '/unlock')
    await probe.locator('#unlock-password').waitFor()
    popup = await reopenPopup()
    for (let attempt = 0; attempt < 6; attempt++) {
      assert(await probe.locator('#unlock-password').isVisible(), 'Persisted local pause must deny a new document while Identity remains ON')
      await reveal()
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally { await probe.close() }
  popup = await reopenPopup()
  await popup.click('Settings'); await popup.click('Shared unlock')
  recordCheck('failed-web-off-preserves-account-on-but-blocks-new-document-unlock')

  setStage('settings-failed-off-explicit-retry-persists-original-choice')
  const retried = writeResponse()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  assert.equal((await retried).status(), 200, 'Explicit retry must persist the actual OFF choice')
  await waitWeb(false); await popup.waitSwitch('Shared unlock', false)
  await page.getByText('Disabled for your account', { exact: true }).waitFor()
  recordCheck('explicit-retry-saves-failed-off-and-clears-pause')
  const enabled = writeResponse(); await toggle().click()
  assert.equal((await enabled).status(), 200)
  await waitWeb(true); await popup.waitSwitch('Shared unlock', true)

  setStage('settings-concurrent-off-produces-real-identity-conflict')
  let release, observed, timer
  let held = false
  const gate = new Promise(resolve => { release = resolve })
  const intercepted = new Promise((resolve, reject) => {
    observed = resolve
    timer = setTimeout(() => reject(new Error('Own preference write was not intercepted')), 8000)
  })
  const holdWrite = async route => {
    if (route.request().method() !== 'PUT' || held) { await route.fallback(); return }
    held = true; observed(); clearTimeout(timer)
    await gate
    await route.continue()
  }
  await page.route(endpoint, holdWrite)
  try {
    const stale = writeResponse()
    await toggle().click(); await intercepted
    await popup.click('Shared unlock', 'switch')
    await popup.waitSwitch('Shared unlock', false)
    release()
    assert.equal((await stale).status(), 409, 'Identity must reject the actual stale revision after the Extension write')
    await page.getByText('The account preference changed elsewhere. Check the current setting and retry your choice. Synchronization remains locally paused.', { exact: true }).waitFor()
    await waitWeb(false); await reveal()
    recordCheck('real-concurrent-preference-write-returns-409-without-overriding-peer')
  } finally { clearTimeout(timer); release(); await page.unroute(endpoint, holdWrite) }

  setStage('settings-conflict-retry-uses-current-revision')
  const repaired = writeResponse()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  assert.equal((await repaired).status(), 200)
  await page.getByText('Disabled for your account', { exact: true }).waitFor()
  recordCheck('explicit-conflict-retry-uses-current-revision-and-clears-pause')
  const restored = writeResponse(); await toggle().click()
  assert.equal((await restored).status(), 200)
  await waitWeb(true); await popup.waitSwitch('Shared unlock', true)
  await reveal(); await popup.click('Back')
}
