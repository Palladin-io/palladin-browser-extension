import assert from 'node:assert/strict'
import { generateTotp } from '@palladin/crypto'

// Real account enrollment and login through Web UI. The test authenticator's
// seed/codes stay in process memory; reports receive only fixed check labels.
export async function verifyTotpSharedUnlock({ page, popup, apiUrl, webOrigin,
  email, password, vaultId, entryId, entryPassword, setStage, recordCheck }) {
  let seed = '', enrollmentCode = ''
  let enrolledStep = 0
  const params = () => ({ secret: seed, algorithm: 'SHA1', digits: 6, period: 30 })
  try {
    setStage('totp-enrollment')
    await page.goto(webOrigin + '/settings/security')
    await page.getByRole('button', { name: 'Enable 2FA', exact: true }).click()
    const setup = page.getByRole('dialog', { name: 'Enable Two-Factor Authentication', exact: true })
    await setup.locator('#totp-secret').waitFor()
    seed = await setup.locator('#totp-secret').inputValue()
    assert(seed.length > 0, 'Real enrollment must provide the test authenticator seed')
    // Avoid consuming a code on the edge of its time step.
    if (Date.now() % 30000 > 27000) await new Promise(resolve => setTimeout(resolve, 31000 - Date.now() % 30000))
    enrolledStep = Math.floor(Date.now() / 30000)
    enrollmentCode = (await generateTotp(params())).code
    await setup.locator('#totp-confirm-code').fill(enrollmentCode)
    const confirmed = page.waitForResponse(r => r.url() === apiUrl + '/api/auth/totp/confirm')
    await setup.getByRole('button', { name: 'Enable', exact: true }).click()
    assert.equal((await confirmed).status(), 200, 'Real Identity must confirm enrollment')
    // Do not read, copy, download or report the recovery codes.
    await page.getByRole('dialog', { name: 'Save Your Recovery Codes', exact: true })
      .getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Disable 2FA', exact: true }).waitFor()
    recordCheck('actual-totp-enrollment-through-web-and-identity')

    setStage('totp-logout-before-fresh-login')
    const loggedOutDocument = page.waitForEvent('domcontentloaded')
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    await loggedOutDocument
    await page.waitForURL(url => url.pathname === '/login')
    await page.waitForLoadState('networkidle')
    await popup.waitButton('Sign in')
    assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Logged-out peer must deny the actual Entry')

    setStage('totp-password-alone-does-not-unlock-peer')
    await page.locator('#login-email').fill(email)
    await page.locator('#login-password').fill(password)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.locator('#totp-code').waitFor()
    for (let attempt = 0; attempt < 6; attempt++) {
      assert(await page.locator('#totp-code').isVisible(), 'Web must retain the second-factor challenge')
      assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Password alone must not unlock the peer')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    recordCheck('password-alone-cannot-unlock-peer-before-totp')

    setStage('totp-invalid-code-does-not-unlock-peer')
    const now = Date.now()
    const nearbyCodes = await Promise.all([-60000, -30000, 0, 30000, 60000]
      .map(offset => generateTotp(params(), now + offset).then(value => value.code)))
    let invalid = 0
    while (nearbyCodes.includes(String(invalid).padStart(6, '0'))) invalid++
    await page.locator('#totp-code').fill(String(invalid).padStart(6, '0'))
    const rejected = page.waitForResponse(r => r.url() === apiUrl + '/api/auth/login/totp')
    await page.getByRole('button', { name: 'Verify', exact: true }).click()
    assert.equal((await rejected).status(), 401, 'Identity must reject an incorrect second factor')
    await page.getByText('Invalid code. Please try again.', { exact: true }).waitFor()
    assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Rejected TOTP must not publish peer keys')
    recordCheck('invalid-totp-rejected-with-peer-entry-still-denied')

    setStage('totp-valid-code-completes-own-login-and-peer-unlock')
    // Enrollment consumed its step. Wait for a genuinely new code, never alter
    // server time, disable replay protection or submit a future-window code.
    const nextStep = (enrolledStep + 1) * 30000 + 500
    if (Date.now() < nextStep) await new Promise(resolve => setTimeout(resolve, nextStep - Date.now()))
    await page.locator('#totp-code').fill((await generateTotp(params())).code)
    const accepted = page.waitForResponse(r => r.url() === apiUrl + '/api/auth/login/totp')
    await page.getByRole('button', { name: 'Verify', exact: true }).click()
    assert.equal((await accepted).status(), 200, 'Identity must complete the actual TOTP challenge')
    await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
    await popup.waitText('Unlocked')
    await popup.waitText('Synthetic shared unlock proof')
    assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
      'Peer must freshly decrypt the actual Entry after verified TOTP')
    recordCheck('valid-totp-login-automatically-unlocks-peer-and-decrypts-entry')
  } finally {
    seed = ''; enrollmentCode = ''
  }
}
