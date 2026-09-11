import assert from 'node:assert/strict'
import { waitForWebEntryPassword } from './native-web-entry.mjs'

// Exercise the real Identity limiter through the normal UI. No response mocks,
// bucket resets, clock changes, credential logging or client-state injection.
export async function verifyAuthorizationRateLimitRetry({ page, popup, apiUrl,
  password, vaultId, entryId, entryPassword, setStage, recordCheck, recordRequest }) {
  const authorizationUrl = apiUrl + '/api/account/shared-unlock/authorizations'
  let authorizationRequests = 0
  const observe = request => {
    if (request.url() === authorizationUrl && request.method() === 'POST') authorizationRequests++
  }
  page.on('request', observe)
  const unlock = async () => {
    const response = page.waitForResponse(value => value.url() === authorizationUrl
      && value.request().method() === 'POST')
    void response.catch(() => {})
    await page.locator('#unlock-password').fill(password)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    const result = await response
    await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
    return result
  }
  const lock = async () => {
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await page.locator('#unlock-password').waitFor()
    await popup.waitButton('Unlock')
    assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Locked peer must deny actual Entry access')
  }
  try {
    let denied, deniedAt
    for (let attempt = 1; attempt <= 12; attempt++) {
      setStage(`authorization-rate-limit-manual-attempt-${attempt}`)
      const response = await unlock()
      recordRequest({ check: 'explicit-rate-limit-attempt', attempt, status: response.status() })
      if (response.status() === 429) { denied = response; deniedAt = Date.now(); break }
      assert.equal(response.status(), 200, 'Only successful authorization or actual throttling belongs to this scenario')
      await popup.waitText('Unlocked')
      await lock()
    }
    assert(denied, 'The real limiter must be observed; an unexercised rejection cannot pass')
    const header = await denied.headerValue('retry-after')
    assert(header !== null && /^\d+$/.test(header), 'Server must provide a numeric Retry-After')
    const seconds = Number(header)
    assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60, 'Expected a bounded one-minute limiter window')
    const requestCountAtDenial = authorizationRequests
    recordRequest({ check: 'authorization-retry-after', seconds })
    setStage('authorization-rate-limit-web-remains-usable')
    await popup.waitButton('Unlock')
    assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Rejected authorization must not install peer keys')
    await page.getByRole('link', { name: 'Vaults', exact: true }).click()
    await page.getByText('Personal', { exact: true }).first().click()
    await page.getByText('Synthetic shared unlock proof', { exact: true }).first().click()
    await waitForWebEntryPassword(page, entryPassword)
    recordCheck('real-429-preserves-web-entry-decryption-and-denies-peer-key-use')
    setStage('authorization-rate-limit-server-cooldown')
    const retryAt = deniedAt + seconds * 1000 + 1000
    while (Date.now() < retryAt) {
      assert.equal(await page.locator('#unlock-password').isVisible(), false,
        'A fresh 15-minute own Web session must not relock during a <=60-second limiter window')
      await waitForWebEntryPassword(page, entryPassword)
      assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Peer must stay locked throughout the server cooldown')
      await new Promise(resolve => setTimeout(resolve, Math.min(500, retryAt - Date.now())))
    }
    assert.equal(authorizationRequests, requestCountAtDenial, 'No automatic replay of the rejected password proof')
    await waitForWebEntryPassword(page, entryPassword)
    recordCheck('server-retry-after-preserves-web-decryption-without-proof-replay-or-peer-key-use')
    setStage('authorization-rate-limit-prepare-fresh-retry')
    await lock()
    await popup.waitButton('Unlock')
    assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Peer must remain locked before the fresh retry')
    setStage('authorization-rate-limit-submit-fresh-retry')
    const retry = await unlock()
    assert.equal(retry.status(), 200, 'Fresh explicit authorization after Retry-After must succeed')
    await popup.waitText('Unlocked')
    await popup.waitText('Synthetic shared unlock proof')
    assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword),
      'Fresh handoff after cooldown must restore actual peer Entry decryption')
    recordCheck('fresh-manual-retry-after-real-429-restores-peer-entry-decryption')
  } finally { page.off('request', observe) }
}
