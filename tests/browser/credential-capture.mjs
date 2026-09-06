import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi } from './capture-api.mjs'
import { openNativePopup } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const api = await createCaptureApi()
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-capture-browser-'))
let context
let popup
let worker
let capturePage
const artifactDir = path.resolve('test-results/credential-capture')
await mkdir(artifactDir, { recursive: true })
try {
  const extension = path.join(profile, 'dist/chromium')
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' },
    maxBuffer: 4 * 1024 * 1024,
  })
  cacheBustContentLoaders(profile, 'chromium')
  validateBuiltManifest(profile, 'chromium')
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] })
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 })
  await worker.evaluate(() => {
    globalThis.captureTestObservations = []
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message.channel === 'palladin.credential-capture') {
        const observation = {
        type: message.type, idLength: message.documentId?.length, frameId: sender.frameId,
        lifecycle: sender.documentLifecycle, hasBrowserDocument: Boolean(sender.documentId),
        hasTabUrl: typeof sender.tab?.url === 'string', hasSenderUrl: typeof sender.url === 'string',
        outcome: message.outcome,
        autoUpdate: message.type === 'save' ? message.autoUpdate : undefined,
        kind: message.type === 'submitted' ? message.credential?.kind : undefined,
        hasPreviousPassword: message.type === 'submitted' ? message.credential?.previousPassword !== null : undefined,
      }
        globalThis.captureTestObservations.push(observation)
        void chrome.tabs.get(sender.tab.id).then((tab) => { observation.hasLookupUrl = typeof tab.url === 'string' })
      }
    })
  })
  const extensionId = new URL(worker.url()).host
  await context.route('https://**/*', async (route) => {
    const url = new URL(route.request().url())
    if (!url.hostname.endsWith('.example.test')) return route.abort()
    return route.fulfill({ contentType: 'text/html', body: fixturePage(url) })
  })
  await context.route(/^http:\/\/[^/]+\.example\.test\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: fixturePage(new URL(route.request().url())) }))
  const onboarding = context.pages().find((page) => page.url().includes('/onboarding/'))
    ?? await context.waitForEvent('page', { predicate: (page) => page.url().includes('/onboarding/') })
  await onboarding.close()
  popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin')
  await popup.fill('input[type="email"]', api.email)
  await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in')
  await popup.waitText('No entries yet.')
  console.log('PASS: real popup sign-in and cryptographic unlock against synthetic provider')

  const page = await context.newPage()
  capturePage = page
  const capturedPasswords = []
  const cdp = await context.newCDPSession(page)
  const ax = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes
  const find = async (role, name) => (await ax()).find((node) => !node.ignored && node.role?.value === role && node.name?.value === name)
  const wait = async (check, label) => {
    const end = Date.now() + 15000
    while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw new Error(`Browser acceptance timed out: ${label}; API requests: ${api.requests.slice(-12).join(', ')}`)
  }
  const click = async (role, name) => {
    await wait(() => find(role, name), name)
    const node = await find(role, name)
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })
    await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2)
  }
  const submit = async ({ host, kind, mode, username, password, previousPassword, failure = false }) => {
    capturedPasswords.push(password)
    await page.bringToFront()
    await page.goto(`https://${host}.example.test/${kind}?mode=${mode}${failure ? '&failure=1' : ''}`)
    await page.getByLabel('Username', { exact: true }).fill(username)
    if (kind === 'password-change') await page.getByLabel('Current password', { exact: true }).fill(previousPassword)
    await page.getByLabel('Password', { exact: true }).fill(password)
    if (kind !== 'login') await page.getByLabel('Confirm password', { exact: true }).fill(password)
    if (mode === 'classic') {
      await page.getByLabel(kind === 'login' ? 'Password' : 'Confirm password', { exact: true }).press('Enter')
    } else {
      await page.getByRole('heading', { name: 'Credential capture test' }).click()
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
    }
    await page.getByRole(failure ? 'alert' : 'status').waitFor()
  }
  const absent = async () => {
    await page.waitForTimeout(1600)
    assert.equal(await page.locator('palladin-capture').count(), 0, 'No capture prompt after a suppressed submission')
  }
  for (const mode of ['spa', 'classic']) {
    for (const kind of ['login', 'registration']) {
      const host = `${mode}-${kind}`
      const password = `Synthetic-${mode}-${kind}-first!`
      const writeCount = api.writes.length
      await submit({ host, kind, mode, username: 'alice', password })
      await click('button', 'Save in Personal')
      await wait(() => api.writes.length === writeCount + 1, 'encrypted create')
      await wait(() => ax().then((nodes) => nodes.some((node) => node.name?.value === 'Login saved')), 'save toast')
      const write = api.writes.at(-1)
      assert.equal(write.vaultId, api.vaults[0].detail.id)
      const secret = await api.decrypt(write)
      assert.equal(secret.content.username, 'alice')
      assert.equal(secret.content.password, password)
      assert.equal(secret.content.urlDomain, `${host}.example.test`)
      assert(!JSON.stringify(write.request).includes(password))
      assert.equal(await page.locator('palladin-capture').evaluate((host) => host.shadowRoot), null)
      console.log(`PASS: ${mode} ${kind}, one-click save to Personal, actual encrypted mutation`)

      const updatePassword = `Synthetic-${mode}-${kind}-second!`
      const before = api.writes.length
      await submit({ host, kind: 'password-change', mode, username: 'alice', password: updatePassword, previousPassword: password })
      const label = `Update ${host}.example.test (alice)`
      await wait(() => find('button', label), 'update suggestion')
      const checkbox = await find('checkbox', 'Automatically update passwords for this account')
      assert(checkbox, 'Account-specific checkbox is visible')
      assert.equal(checkbox.properties.find((property) => property.name === 'checked').value.value, 'false')
      await page.screenshot({ path: path.join(artifactDir, `${mode}-${kind}-prompt.png`) })
      await click('checkbox', 'Automatically update passwords for this account')
      await wait(async () => (await find('checkbox', 'Automatically update passwords for this account'))
        ?.properties.find((property) => property.name === 'checked')?.value.value === 'true', 'account checkbox checked before Update')
      await click('button', label)
      await wait(() => api.writes.length === before + 1, 'manual update with opt-in')
      assert.equal(api.writes.at(-1).entryId, write.entryId)
      assert.equal((await api.decrypt(write)).content.password, updatePassword)
      await wait(() => ax().then((nodes) => nodes.some((node) => node.name?.value === 'Password updated')), 'update success toast')
      const consent = await worker.evaluate(async (entryId) => {
        const values = await chrome.storage.local.get('palladin.capture-preferences.v1')
        return (values['palladin.capture-preferences.v1'] ?? []).flatMap((profile) => profile.automaticUpdates)
          .find((binding) => binding.entryId === entryId)
      }, write.entryId)
      assert.deepEqual(consent, { vaultId: write.vaultId, entryId: write.entryId,
        revision: '2', origin: `https://${host}.example.test` }, 'Success must follow durable consent for exactly this Entry revision and origin')
      await page.screenshot({ path: path.join(artifactDir, `${mode}-${kind}-updated.png`) })

      const finalPassword = `Synthetic-${mode}-${kind}-third!`
      await submit({ host, kind: 'password-change', mode, username: 'alice', password: finalPassword, previousPassword: updatePassword })
      await wait(() => api.writes.length === before + 2, 'automatic account update without clicks')
      assert.equal(api.writes.at(-1).entryId, write.entryId)
      assert.equal((await api.decrypt(write)).content.password, finalPassword)
      await wait(() => ax().then((nodes) => nodes.some((node) => node.name?.value === 'Password updated')), 'automatic update success toast')
      console.log(`PASS: ${mode} password change, default-off opt-in, subsequent automatic update`)
    }
  }
  let before = api.writes.length
  await submit({ host: 'team-registration', kind: 'registration', mode: 'spa', username: 'team-user', password: 'Synthetic-team-account!' })
  await click('button', 'Change...')
  await click('button', 'Save in Team')
  assert.equal(api.writes.length, before, 'Choosing a vault does not save')
  await click('button', 'Save in Team')
  await wait(() => api.writes.length === before + 1, 'save to selected Team vault')
  assert.equal(api.writes.at(-1).vaultId, api.vaults[1].detail.id)
  await wait(() => ax().then((nodes) => nodes.some((node) => node.name?.value === 'Login saved')), 'Team save toast')
  console.log('PASS: registration defaults to Personal and Change allows an explicit Team save')

  before = api.writes.length
  for (const mode of ['spa', 'classic']) {
    await submit({ host: 'rejected-login', kind: 'login', mode, username: 'alice', password: 'Synthetic-rejected!', failure: true })
    await absent()
    await submit({ host: `${mode}-login`, kind: 'login', mode, username: 'alice', password: `Synthetic-${mode}-login-third!` })
    await absent()
    assert.equal(api.writes.length, before)
  }
  console.log('PASS: rejected and identical logins produce neither prompts nor writes in SPA/classic pages')

  popup.close()
  popup = await openNativePopup(worker, profile, extensionId)
  if (await popup.hasButton('Back')) await popup.click('Back')
  await popup.click('Settings')
  await popup.click('Save and update logins')
  const disable = 'Turn off automatic updates for spa-login.example.test'
  await popup.click(disable)
  await wait(async () => !await popup.hasButton(disable), 'account opt-in disabled in settings')
  await submit({ host: 'spa-login', kind: 'password-change', mode: 'spa', username: 'alice',
    password: 'Synthetic-after-opt-out!', previousPassword: 'Synthetic-spa-login-third!' })
  await wait(() => find('button', 'Update spa-login.example.test (alice)'), 'manual update after opt-out')
  assert.equal(api.writes.length, before)
  await click('button', 'Not now')
  assert.equal(api.writes.length, before)
  console.log('PASS: disabling one account restores manual confirmation; Not now makes no mutation')

  await submit({ host: 'muted-login', kind: 'login', mode: 'spa', username: 'alice', password: 'Synthetic-muted!' })
  await click('button', "Don't ask for this site")
  await submit({ host: 'muted-login', kind: 'login', mode: 'classic', username: 'alice', password: 'Synthetic-muted-again!' })
  await absent()
  assert.equal(api.writes.length, before)
  popup.close()
  popup = await openNativePopup(worker, profile, extensionId)
  if (await popup.hasButton('Back')) await popup.click('Back')
  await popup.click('Settings')
  await popup.click('Save and update logins')
  await popup.click('Enable save suggestions on example.test')
  await wait(() => popup.hasText('Save suggestions are enabled on all sites.'), 'unmuted settings')
  await submit({ host: 'muted-login', kind: 'login', mode: 'spa', username: 'alice', password: 'Synthetic-unmuted!' })
  await click('button', 'Dismiss save suggestion')
  assert.equal(api.writes.length, before)
  console.log('PASS: site mute persists across navigation, settings re-enables capture, dismissal does not save')

  await page.goto('https://generator.example.test/registration?mode=spa')
  await page.getByLabel('Username', { exact: true }).fill('generator-user')
  await page.getByRole('heading', { name: 'Credential capture test' }).click()
  await page.getByLabel('Password', { exact: true }).click()
  popup.close()
  popup = await openNativePopup(worker, profile, extensionId)
  if (await popup.hasButton('Back')) await popup.click('Back')
  await popup.click('Use strong password')
  await popup.click('Fill')
  await popup.waitText('Filled in the active page')
  const generated = await page.getByLabel('Password', { exact: true }).inputValue()
  assert(generated.length >= 16)
  assert.equal(await page.getByLabel('Confirm password', { exact: true }).inputValue(), generated)
  capturedPasswords.push(generated)
  assert.equal(api.writes.length, before, 'Generator fill alone does not save')
  await popup.click('Save to Palladin')
  await popup.waitText('Saved securely to Palladin')
  assert.equal(api.writes.length, before + 1)
  const generatedEntry = await api.decrypt(api.writes.at(-1))
  assert.equal(generatedEntry.content.password, generated)
  assert.equal(generatedEntry.content.username, '', 'Existing generator save is password-only (CVT-374)')
  await page.bringToFront()
  await page.getByLabel('Confirm password', { exact: true }).press('Enter')
  await page.getByRole('status').waitFor()
  // The submitted username differs from CVT-374's password-only Entry; a full account still needs consent.
  await wait(() => find('button', 'Save in Personal'), 'explicit capture of the submitted account')
  assert.equal(api.writes.length, before + 1, 'The new capture does not silently add another Entry')
  await click('button', 'Not now')
  console.log('PASS: existing generator fills both fields and saves explicitly; account capture never adds an Entry without consent')

  before = api.writes.length
  popup.close()
  popup = await openNativePopup(worker, profile, extensionId)
  if (await popup.hasButton('Back')) await popup.click('Back')
  await popup.click('Lock')
  await popup.waitText('Enter your master password to unlock your vault.')
  await submit({ host: 'locked-login', kind: 'login', mode: 'classic', username: 'locked-user', password: 'Synthetic-locked-capture!' })
  await click('button', 'Unlock Palladin')
  popup.close()
  popup = await openNativePopup(worker, profile, extensionId)
  await popup.fill('input[type="password"]', api.password)
  await popup.click('Unlock')
  await page.bringToFront()
  await click('button', 'Save in Personal')
  await wait(() => api.writes.length === before + 1, 'locked capture continues after real popup unlock')
  assert.equal((await api.decrypt(api.writes.at(-1))).content.password, 'Synthetic-locked-capture!')
  console.log('PASS: classic submission while locked resumes after explicit popup unlock and one-click Save')

  before = api.writes.length
  await submit({ host: 'granted-login', kind: 'login', mode: 'spa', username: 'grant-user', password: 'Synthetic-granted-initial!' })
  await click('button', 'Save in Personal')
  await wait(() => api.writes.length === before + 1, 'create with active FULL grant')
  const grantedWrite = api.writes.at(-1)
  assert.equal(grantedWrite.request.grantEnvelopes, undefined, 'FULL creation has no per-Entry grant fan-out')
  const vault = api.vaults.find(({ detail }) => detail.id === grantedWrite.vaultId)
  const granular = vault.grantFixture.addGranular(grantedWrite.entryId)
  const scriptGrant = await api.addScriptFor(grantedWrite)
  await submit({ host: 'granted-login', kind: 'password-change', mode: 'classic', username: 'grant-user',
    password: 'Synthetic-granted-replacement!', previousPassword: 'Synthetic-granted-initial!' })
  api.rejectNextUpdate()
  await click('button', 'Update granted-login.example.test (grant-user)')
  await wait(() => ax().then((nodes) => nodes.some((node) => node.name?.value === 'Could not save. Try again.')), 'visible mutation failure')
  assert.equal(api.writes.length, before + 1, 'Rejected atomic mutation has not replaced the Entry')
  assert.equal((await api.decrypt(grantedWrite)).content.password, 'Synthetic-granted-initial!')
  await click('button', 'Update granted-login.example.test (grant-user)')
  await wait(() => api.writes.length === before + 2, 'explicit retry of Entry and grant mutation')
  const replacement = api.writes.at(-1)
  assert.equal(replacement.request.grantEnvelopes.length, 1, 'Only GRANULAR needs a replacement')
  assert.equal(replacement.request.scriptGrantPackages.length, 1)
  await vault.grantFixture.verifyGranular(replacement.request.grantEnvelopes[0], granular, '2', 'Synthetic-granted-replacement!')
  await vault.grantFixture.verifyScript(replacement.request.scriptGrantPackages[0], scriptGrant, vault.detail,
    grantedWrite.entryId, 'Synthetic-granted-replacement!')
  assert.equal((await api.decrypt(replacement)).content.password, 'Synthetic-granted-replacement!')
  console.log('PASS: FULL has no per-Entry fan-out; explicit retry sends Entry, scope-preserving GRANULAR and complete decryptable ScriptExecution replacement')

  before = api.writes.length
  await submit({ host: 'ambiguous-login', kind: 'registration', mode: 'spa', username: 'shared-user', password: 'Synthetic-ambiguous-personal!' })
  await click('button', 'Save in Personal')
  await wait(() => api.writes.length === before + 1, 'first account candidate')
  const personalCandidate = api.writes.at(-1)
  await submit({ host: 'ambiguous-login', kind: 'registration', mode: 'classic', username: 'shared-user', password: 'Synthetic-ambiguous-team!' })
  await click('button', 'Change...')
  await click('button', 'Save in Team')
  await click('button', 'Save in Team')
  await wait(() => api.writes.length === before + 2, 'second account candidate')
  const teamCandidate = api.writes.at(-1)
  await submit({ host: 'ambiguous-login', kind: 'password-change', mode: 'spa', username: 'shared-user',
    password: 'Synthetic-ambiguous-updated!', previousPassword: 'Synthetic-ambiguous-team!' })
  await wait(() => find('button', 'Save in Personal'), 'ambiguous account defaults to creation')
  assert.equal(api.writes.length, before + 2, 'Ambiguous accounts are never automatically updated')
  await click('button', 'Change...')
  await click('button', 'Update ambiguous-login.example.test (shared-user) Team')
  assert.equal(api.writes.length, before + 2, 'Choosing a concrete Entry is not a mutation')
  await click('button', 'Update ambiguous-login.example.test (shared-user)')
  await wait(() => api.writes.length === before + 3, 'explicitly selected account update')
  assert.equal(api.writes.at(-1).entryId, teamCandidate.entryId)
  assert.equal(api.writes.at(-1).vaultId, teamCandidate.vaultId)
  assert.equal((await api.decrypt(personalCandidate)).content.password, 'Synthetic-ambiguous-personal!')
  assert.equal((await api.decrypt(teamCandidate)).content.password, 'Synthetic-ambiguous-updated!')
  console.log('PASS: ambiguous accounts default to Personal creation; visible account/Vault choice updates only the explicitly selected Entry')

  before = api.writes.length
  const boundaryPassword = 'Synthetic-boundary-only!'
  capturedPasswords.push(boundaryPassword)
  await page.goto('http://insecure.example.test/login?mode=spa')
  await page.getByLabel('Username', { exact: true }).fill('boundary-user')
  await page.getByLabel('Password', { exact: true }).fill(boundaryPassword)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.getByRole('status').waitFor()
  await absent()

  await page.goto('https://parent.example.test/embedded')
  const child = page.frameLocator('iframe')
  await child.getByLabel('Username', { exact: true }).fill('boundary-user')
  await child.getByLabel('Password', { exact: true }).fill(boundaryPassword)
  await child.getByRole('button', { name: 'Submit', exact: true }).click()
  await child.getByRole('status').waitFor()
  await absent()
  assert.equal(await child.locator('palladin-capture').count(), 0)

  await page.goto('https://untrusted-submit.example.test/login?mode=spa')
  await page.getByLabel('Username', { exact: true }).fill('boundary-user')
  await page.getByLabel('Password', { exact: true }).fill(boundaryPassword)
  await page.evaluate(() => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await page.getByRole('status').waitFor()
  await absent()
  assert.equal(api.writes.length, before)
  console.log('PASS: HTTP, cross-origin iframe and script-dispatched submit cannot capture or mutate credentials')

  await submit({ host: 'covered-toast', kind: 'login', mode: 'spa', username: 'boundary-user', password: boundaryPassword })
  await wait(() => find('button', 'Save in Personal'), 'toast before hostile overlay')
  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.id = 'test-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white'
    document.documentElement.append(overlay)
  })
  await click('button', 'Save in Personal')
  await page.waitForTimeout(500)
  assert.equal(api.writes.length, before, 'Clicking through a page overlay cannot save')
  await page.evaluate(() => document.getElementById('test-overlay').remove())
  await click('button', 'Not now')
  await absent()

  await submit({ host: 'leaving-origin', kind: 'login', mode: 'spa', username: 'boundary-user', password: boundaryPassword })
  await wait(() => find('button', 'Save in Personal'), 'pending prompt before origin change')
  await page.goto('https://elsewhere.example.test/login?mode=spa')
  await page.goto('https://leaving-origin.example.test/login/complete?mode=spa')
  await absent()
  assert.equal(api.writes.length, before)
  console.log('PASS: covered toast cannot save; leaving and returning to an origin does not resurrect pending credentials')

  const persisted = JSON.stringify(await worker.evaluate(async () => {
    const databases = []
    for (const database of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database.name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error('Test cache read failed'))
      })
      for (const name of db.objectStoreNames) databases.push(await new Promise((resolve, reject) => {
        const request = db.transaction(name, 'readonly').objectStore(name).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error('Test cache read failed'))
      }))
      db.close()
    }
    return [await chrome.storage.local.get(null), await chrome.storage.session.get(null), databases]
  }))
  const keyRepresentations = api.vaults.flatMap((vault) => [
    Buffer.from(vault.vaultKey).toString('base64url'), Buffer.from(vault.vaultKey).toString('base64'),
    JSON.stringify(vault.vaultKey), JSON.stringify([...vault.vaultKey]),
  ])
  assert([...capturedPasswords, api.password, ...keyRepresentations]
    .every((secret) => !persisted.includes(secret)), 'No plaintext credentials or Vault keys in extension persistent storage')
  console.log('PASS: inspected chrome storage and IndexedDB contain no synthetic plaintext passwords or Vault keys')
  assert.deepEqual(api.errors, [])
  console.log(`PASS: ${api.writes.length} encrypted writes; browser artifacts: ${artifactDir}`)
} catch (error) {
  if (capturePage) {
    const captureCdp = await context.newCDPSession(capturePage)
    const nodes = (await captureCdp.send('Accessibility.getFullAXTree')).nodes
    console.error('Capture UI state:', { url: capturePage.url(),
      controls: nodes.filter((node) => !node.ignored && ['button', 'checkbox', 'status'].includes(node.role?.value))
        .map((node) => ({ role: node.role.value, name: node.name?.value, checked: node.properties?.find((property) => property.name === 'checked')?.value.value })) })
  }
  console.error('Capture preferences:', await worker?.evaluate(async () => {
    const values = await chrome.storage.local.get('palladin.capture-preferences.v1')
    return values['palladin.capture-preferences.v1']
  }).catch(() => undefined))
  await popup?.screenshot(path.join(artifactDir, 'failure-popup.png')).catch(() => undefined)
  for (const [index, page] of (context?.pages() ?? []).entries()) {
    await page.screenshot({ path: path.join(artifactDir, `failure-${index}.png`) }).catch(() => undefined)
  }
  console.error('Synthetic provider paths:', api.requests.slice(-15).join(', '))
  console.error('Capture message shapes:', await worker?.evaluate(() => globalThis.captureTestObservations.slice(-12)).catch(() => []))
  throw error
} finally {
  popup?.close()
  await context?.close()
  await api.close()
  await rm(profile, { recursive: true, force: true })
}

function fixturePage(url) {
  if (url.pathname === '/embedded') return '<!doctype html><html><body><iframe title="External login" style="width:100%;height:700px" src="https://child.example.test/login?mode=spa"></iframe></body></html>'
  const kind = url.pathname.split('/')[1]
  const failure = url.searchParams.has('failure')
  const mode = url.searchParams.get('mode')
  const complete = url.pathname.endsWith('/complete')
  const message = failure ? 'Invalid password' : kind === 'password-change' ? 'Password successfully changed'
    : kind === 'registration' ? 'Account created' : 'Successfully signed in'
  const outcome = `<div role="${failure ? 'alert' : 'status'}">${message}</div>`
  const form = `<form method="post" action="/${kind}/complete?${url.searchParams}">
    <label>Username<input name="username" autocomplete="username"></label>
    ${kind === 'password-change' ? '<label>Current password<input type="password" name="old" autocomplete="current-password"></label>' : ''}
    <label>Password<input type="password" name="password" autocomplete="${kind === 'login' ? 'current-password' : 'new-password'}"></label>
    ${kind !== 'login' ? '<label>Confirm password<input type="password" name="confirm" autocomplete="new-password"></label>' : ''}
    <button type="submit">Submit</button></form>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic capture acceptance</title>
    <style>body{font:16px system-ui;margin:80px;max-width:600px;background:#f3f5f8;color:#0c0e12}label{display:block;margin:16px 0}input{display:block;padding:10px}button{padding:12px}</style></head>
    <body><h1>Credential capture test</h1>${complete ? outcome : form}
    ${!complete && mode === 'spa' ? `<script>document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); document.querySelector('form').outerHTML = ${JSON.stringify(outcome)};
    });</script>` : ''}</body></html>`
}
