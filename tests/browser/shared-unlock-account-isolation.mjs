import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

// Two accounts are created and authenticated through the real product UI.
// Credentials and Entry values stay in memory; evidence contains booleans only.
export async function verifySharedUnlockAccountIsolation({ page, popup, apiUrl,
  webOrigin, email, password, vaultId, entryId, entryPassword, allowEmail,
  verificationFor, setStage, recordCheck }) {
  const emailB = `cvt583-${randomBytes(8).toString('hex')}@example.test`
  const passwordB = 'Synthetic!' + randomBytes(24).toString('base64url')
  const entryPasswordB = 'Entry!' + randomBytes(24).toString('base64url')
  const revealA = async () => assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
    'Extension must retain access to its own account A Entry')
  const stable = async check => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await check(); await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  const login = async (accountEmail, accountPassword) => {
    await page.locator('#login-email').fill(accountEmail)
    await page.locator('#login-password').fill(accountPassword)
    await page.getByRole('button', { name: /^Sign in$/i }).click()
    await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  }
  const logout = async () => {
    const reloaded = page.waitForEvent('domcontentloaded')
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    await reloaded; await page.locator('#login-email').waitFor()
    await page.waitForLoadState('networkidle')
  }
  const settings = async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('link', { name: 'Security', exact: true }).click()
  }

  setStage('account-isolation-establish-account-a')
  await page.waitForLoadState('networkidle'); await login(email, password)
  await popup.waitText('Unlocked'); await revealA()
  // OFF allows the user to log out Web without closing their Extension session.
  await settings()
  const off = page.waitForResponse(r => r.url() === apiUrl + '/api/account/shared-unlock' && r.request().method() === 'PUT')
  await page.getByRole('switch', { name: 'Shared unlock', exact: true, checked: true }).click()
  assert.equal((await off).status(), 200)
  await popup.click('Settings'); await popup.click('Shared unlock')
  await popup.waitSwitch('Shared unlock', false)
  await logout(); await revealA()
  recordCheck('account-a-web-logout-with-off-preserves-own-extension-entry')

  setStage('account-isolation-register-independent-account-b')
  allowEmail(emailB)
  await page.goto(webOrigin + '/register')
  await page.locator('#register-email').fill(emailB)
  await page.locator('#register-password').fill(passwordB)
  await page.locator('#register-password-confirm').fill(passwordB)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const words = await page.locator('ol.ph-no-capture li span.font-mono').allTextContents()
  assert.equal(words.length, 24)
  await page.getByRole('button', { name: "I've Saved My Recovery Key", exact: true }).click()
  const inputs = page.locator('input[id^="recovery-word-"]'); await inputs.first().waitFor()
  for (let index = 0; index < await inputs.count(); index++) {
    const input = inputs.nth(index)
    await input.fill(words[Number((await input.getAttribute('id')).split('-').at(-1))])
  }
  words.fill('')
  const registered = page.waitForResponse(r => r.url() === apiUrl + '/api/auth/register')
  await page.getByRole('button', { name: 'Verify & Complete Setup', exact: true }).click()
  assert.equal((await registered).status(), 200)
  let verification
  for (let attempt = 0; attempt < 100 && !verification; attempt++) {
    verification = verificationFor(emailB)
    if (!verification) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert(verification, 'Separate account B must receive its own verification')
  await page.goto(verification)
  await page.getByRole('heading', { name: 'Email Verified', exact: true }).waitFor()
  await page.waitForURL(url => url.pathname !== '/verify-email')
  if (new URL(page.url()).pathname !== '/login') await logout()
  await login(emailB, passwordB)
  await settings()
  await page.getByRole('switch', { name: 'Shared unlock', exact: true, checked: true }).waitFor()
  await popup.waitSwitch('Shared unlock', false); await revealA()
  recordCheck('account-b-default-on-does-not-reuse-account-a-off-preference')
  await popup.click('Shared unlock', 'switch'); await popup.waitSwitch('Shared unlock', true)
  await popup.click('Back')

  setStage('account-isolation-two-distinct-entries')
  await page.getByRole('link', { name: 'Vaults', exact: true }).click()
  await page.getByText('Personal', { exact: true }).first().click()
  await page.getByRole('button', { name: 'Add Entry', exact: true }).first().click()
  for (const [selector, value] of [['#entry-label', 'Synthetic account B proof'],
    ['#entry-username', 'synthetic-account-b-user'], ['#entry-password', entryPasswordB]]) {
    await page.locator(selector).fill(value)
  }
  await page.getByRole('button', { name: 'Save Entry', exact: true }).click()
  await page.waitForURL(url => /^\/vaults\/[^/]+\/entries\/[^/]+$/.test(url.pathname))
  const [, , vaultB, , entryB] = new URL(page.url()).pathname.split('/')
  assert.notEqual(vaultB, vaultId); assert.notEqual(entryB, entryId)
  const revealB = async () => {
    await page.locator('#entry-detail-password').waitFor()
    assert(await page.locator('#entry-detail-password').evaluate((element, expected) => element.value === expected, entryPasswordB),
      'Web must decrypt its own account B Entry')
  }
  await stable(async () => { await revealA(); await revealB() })
  assert(await popup.revealDeniedForOtherAccount(vaultB, entryB), 'Account A must reject account B Entry access')
  recordCheck('both-account-preferences-on-retain-distinct-decrypted-entries')
  recordCheck('extension-account-a-denies-account-b-entry-without-secret-payload')

  setStage('account-isolation-web-b-lock-and-reload')
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await page.locator('#unlock-password').waitFor(); await page.reload()
  await page.locator('#unlock-password').waitFor()
  await stable(async () => {
    assert(await page.locator('#unlock-password').isVisible(), 'Account A must not unlock account B Web')
    await revealA()
  })
  recordCheck('account-b-lock-and-document-reload-do-not-lock-or-adopt-account-a')
  await page.locator('#unlock-password').fill(passwordB)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Vaults', exact: true }).click()
  await page.getByText('Personal', { exact: true }).first().click()
  await page.getByText('Synthetic account B proof', { exact: true }).first().click()
  await revealB(); await revealA()
  recordCheck('manual-account-b-unlock-restores-only-its-own-entry')

  setStage('account-isolation-extension-a-lock')
  await popup.click('Lock'); await popup.waitButton('Unlock')
  await stable(async () => {
    await revealB()
    assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Web account B must not unlock Extension account A')
  })
  recordCheck('account-a-extension-lock-leaves-web-b-unlocked-and-rejects-handoff')
  await popup.fill('input[autocomplete="current-password"]', password)
  await popup.click('Unlock'); await popup.waitText('Unlocked')
  await stable(async () => { await revealA(); await revealB() })
  recordCheck('manual-account-a-unlock-preserves-both-account-identities')

  setStage('account-isolation-web-b-logout')
  await logout()
  await stable(revealA)
  recordCheck('account-b-web-logout-preserves-account-a-extension-entry')
}
