import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs'
import { openNativePopup } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

// Real-Chromium acceptance for remembering federated sign-in methods. Provider
// origins are synthetic Playwright-routed documents with the real provider host
// names; no real provider account, token, cookie or callback is involved.
const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const api = await createCaptureApi()
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-signin-browser-'))
const OAUTH_SECRETS = ['oauth-code-secret', 'oauth-state-secret', 'oauth-nonce-secret']
const SERVICE = 'https://app.example.test'
const googleAuthorize = `https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-client&redirect_uri=${encodeURIComponent(`${SERVICE}/callback`)}&state=oauth-state-secret&nonce=oauth-nonce-secret`
const githubAuthorize = 'https://github.com/login/oauth/authorize?client_id=synthetic-client&state=oauth-state-secret'
let context
let popup
await mkdir(path.resolve('test-results/federated-signin'), { recursive: true })

function page(url) {
  const html = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${url.hostname}</title></head><body>${body}</body></html>`
  if (url.hostname === 'app.example.test' && url.pathname === '/login') return html(`
    <h1>Synthetic service</h1>
    <p><a href="${googleAuthorize.replaceAll('&', '&amp;')}">Continue with Google</a></p>
    <p><button type="button" onclick="window.open('${githubAuthorize}', 'oauth', 'width=520,height=640')">Continue with GitHub</button></p>`)
  if (url.hostname === 'app.example.test') return html('<h1>Signed in to synthetic service</h1>')
  if (url.hostname === 'accounts.google.com') return html(`
    <h1>Synthetic Google authorization</h1>
    <form onsubmit="event.preventDefault()"><label for="identifier">Email or phone</label>
      <input id="identifier" name="identifier" type="email" autocomplete="username"><button type="submit">Next</button></form>
    <p><a href="${SERVICE}/callback?code=oauth-code-secret&amp;state=oauth-state-secret">Allow</a></p>
    <p><a href="${SERVICE}/callback?error=access_denied&amp;state=oauth-state-secret">Cancel</a></p>`)
  if (url.hostname === 'github.com') return html(`
    <h1>Synthetic GitHub authorization</h1>
    <p><a href="${SERVICE}/callback?code=oauth-code-secret&amp;state=oauth-state-secret">Authorize</a></p>`)
  return null
}

try {
  await api.addCredential({ label: 'Alpha Google', username: 'alice@gmail.example', password: 'Synthetic-google-1!', urlDomain: 'accounts.google.com' })
  await api.addCredential({ label: 'Beta Google', username: 'work@corp.example', password: 'Synthetic-google-2!', urlDomain: 'accounts.google.com' })
  const existing = await api.addCredential({ label: 'Synthetic service', username: 'alice', password: 'Synthetic-service-password!', urlDomain: 'app.example.test' })

  const extension = path.join(profile, 'dist/chromium')
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' },
    maxBuffer: 4 * 1024 * 1024,
  })
  cacheBustContentLoaders(profile, 'chromium')
  validateBuiltManifest(profile, 'chromium')
  await allowCaptureApi(extension, api.url)
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 })
  const extensionId = new URL(worker.url()).host
  await context.route('https://**/*', async (route) => {
    const body = page(new URL(route.request().url()))
    return body === null ? route.abort() : route.fulfill({ contentType: 'text/html', body })
  })
  const onboarding = context.pages().find((candidate) => candidate.url().includes('/onboarding/'))
    ?? await context.waitForEvent('page', { predicate: (candidate) => candidate.url().includes('/onboarding/') })
  await onboarding.close()
  popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin')
  await popup.waitButton('Sign in')
  assert.equal((await popup.configureConnection({ name: 'Synthetic sign-in API', apiUrl: api.url,
    webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true)
  await popup.fill('input[type="email"]', api.email)
  await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in')
  await popup.waitText('Alpha Google')
  console.log('PASS: popup sign-in and unlock with seeded synthetic Credentials')

  const tab = await context.newPage()
  const surfaceTools = async (target) => {
    const cdp = await context.newCDPSession(target)
    const ax = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.filter((node) => !node.ignored)
    const find = async (role, name) => (await ax()).find((node) => node.role?.value === role
      && (name instanceof RegExp ? name.test(node.name?.value ?? '') : node.name?.value === name))
    const wait = async (check, label, timeout = 15000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
      throw new Error(`Browser acceptance timed out: ${label}; API: ${api.requests.slice(-8).join(', ')}`)
    }
    const click = async (role, name) => {
      await wait(() => find(role, name), String(name))
      // The closed surface ignores actions for 500 ms after it appears (anti-clickjacking).
      await target.waitForTimeout(600)
      const node = await find(role, name)
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })
      await target.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2)
    }
    return { find, wait, click }
  }
  const ui = await surfaceTools(tab)
  const noSurface = async () => {
    await tab.waitForTimeout(1500)
    assert.equal(await tab.locator('palladin-capture').count(), 0, 'No sign-in surface expected')
  }
  const assertNoOAuthValues = (value, label) => {
    const text = JSON.stringify(value)
    for (const secret of OAUTH_SECRETS) assert(!text.includes(secret), `${label} must not contain ${secret}`)
  }

  // Cancellation: an OAuth error return never asks to remember anything.
  await tab.goto(`${SERVICE}/login`)
  await tab.getByRole('link', { name: 'Continue with Google' }).click()
  await tab.waitForURL(/accounts\.google\.com/)
  await tab.getByRole('link', { name: 'Cancel' }).click()
  await tab.waitForURL(/error=access_denied/)
  await noSurface()
  console.log('PASS: denied/cancelled provider return produces no prompt and no write')

  // Same-tab success: explicit account and target are required, nothing is guessed.
  const writesBefore = api.writes.length
  await tab.goto(`${SERVICE}/login`)
  await tab.getByRole('link', { name: 'Continue with Google' }).click()
  await tab.waitForURL(/accounts\.google\.com/)
  await tab.getByRole('link', { name: 'Allow' }).click()
  await tab.waitForURL(/callback\?code=/)
  await ui.wait(() => ui.find('region', 'Signed in with Google?'), 'remember prompt')
  assert.equal(await ui.find('button', /^Remember for/), undefined, 'No default account or target may be preselected')
  await ui.click('radio', /work@corp\.example/)
  await ui.click('radio', /New sign-in for app\.example\.test/)
  await ui.click('button', 'Remember for New sign-in for app.example.test')
  await ui.wait(() => api.writes.length === writesBefore + 1, 'encrypted create')
  const created = api.writes.at(-1)
  const createdSecret = await api.decrypt(created)
  assert.equal(created.action, 'created')
  assert.deepEqual({ username: createdSecret.content.username, password: createdSecret.content.password,
    urlDomain: createdSecret.content.urlDomain }, { username: '', password: '', urlDomain: 'app.example.test' })
  const field = createdSecret.content.customFields.find((candidate) => candidate.type === 'palladin.signin.v1')
  assert.deepEqual(field.value, { provider: 'google', account: 'work@corp.example' })
  assert.equal(createdSecret.agentFieldAccess[field.id], 'never')
  assertNoOAuthValues(created.request, 'Encrypted create request')
  assert(!JSON.stringify(created.request).includes('work@corp.example'), 'Provider account travels only encrypted')
  console.log('PASS: same-tab Google round trip remembered the explicitly chosen account as an encrypted, never-Agent field')

  // Next visit: suggestion requires a click, Palladin clicks the unique page
  // button and ranks the chosen provider account for automatic identifier fill.
  await tab.waitForTimeout(1500)
  const requestsBeforeSuggestion = api.requests.length
  await tab.goto(`${SERVICE}/login`)
  await ui.wait(() => ui.find('region', 'Sign in with a remembered account'), 'remembered suggestion')
  assert.deepEqual(api.requests.slice(requestsBeforeSuggestion).filter((request) => request.includes('/entries/')), [],
    'Showing suggestions reads only the local encrypted cache')
  assert(tab.url().startsWith(`${SERVICE}/login`), 'A suggestion never navigates on its own')
  await ui.click('button', /Google · work@corp\.example/)
  await tab.waitForURL(/accounts\.google\.com/)
  await ui.wait(async () => (await tab.locator('#identifier').inputValue()) === 'work@corp.example',
    'chosen provider account filled instead of name-sorted Alpha')
  const writesBeforeReturn = api.writes.length
  await tab.getByRole('link', { name: 'Allow' }).click()
  await tab.waitForURL(/callback\?code=/)
  await noSurface()
  assert.equal(api.writes.length, writesBeforeReturn)
  console.log('PASS: explicit suggestion choice opened Google, ranked the chosen account and did not re-prompt')

  // Popup flow from the opener tab, updating the existing service account.
  await tab.goto(`${SERVICE}/login`)
  await ui.wait(() => ui.find('region', 'Sign in with a remembered account'), 'suggestion before popup')
  await ui.click('button', 'Dismiss sign-in suggestion')
  const [oauthPopup] = await Promise.all([context.waitForEvent('page'), tab.getByRole('button', { name: 'Continue with GitHub' }).click()])
  await oauthPopup.waitForURL(/github\.com/)
  await oauthPopup.getByRole('link', { name: 'Authorize' }).click()
  await oauthPopup.waitForURL(/callback\?code=/)
  await tab.bringToFront()
  await ui.wait(() => ui.find('region', 'Signed in with GitHub?'), 'popup prompt in opener tab')
  await ui.click('radio', 'Account not specified')
  await ui.click('radio', /Synthetic service \(alice\)/)
  const writesBeforeUpdate = api.writes.length
  await ui.click('button', 'Remember for Synthetic service (alice)')
  await ui.wait(() => api.writes.length === writesBeforeUpdate + 1, 'encrypted update')
  const updated = api.writes.at(-1)
  assert.equal(updated.entryId, existing.entryId)
  const updatedSecret = await api.decrypt(updated)
  assert.equal(updatedSecret.content.password, 'Synthetic-service-password!')
  assert.deepEqual(updatedSecret.content.customFields.find((candidate) => candidate.type === 'palladin.signin.v1').value,
    { provider: 'github', account: null })
  assertNoOAuthValues(updated.request, 'Encrypted update request')
  await oauthPopup.close()
  console.log('PASS: popup GitHub flow prompted only in the opener tab and updated the chosen existing account')

  const storage = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }))
  assertNoOAuthValues(storage, 'Extension storage')
  assert(!JSON.stringify(storage).includes('work@corp.example'), 'Provider account is not stored outside the encrypted Vault')
  assert.deepEqual(api.errors, [])
  console.log('PASS: extension storage contains no OAuth values or plaintext provider account')
} finally {
  try { await popup?.close?.() } catch { /* The native popup may already be gone. */ }
  await context?.close().catch(() => undefined)
  await api.close()
  await rm(profile, { recursive: true, force: true })
}
