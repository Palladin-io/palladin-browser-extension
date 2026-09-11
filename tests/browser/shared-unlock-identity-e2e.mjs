import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir, platform, arch, release } from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright'
import { openNativePopup } from './native-popup.mjs'

// Explicit, already built clients and isolated local Identity/SES test services.
// No account credentials, recovery words, tokens or keys are written to reports.
const argument = name => process.argv[process.argv.indexOf(name) + 1]
for (const name of ['--web-source', '--api-url', '--ses-url']) assert(process.argv.includes(name), `${name} required`)
const webSource = path.resolve(argument('--web-source')), apiUrl = argument('--api-url'), sesUrl = argument('--ses-url')
const delayManualAuthorization = process.argv.includes('--delay-manual-authorization')
const browserExecutable = process.argv.includes('--browser-executable') ? path.resolve(argument('--browser-executable')) : undefined
const browserLabel = process.argv.includes('--browser-label') ? argument('--browser-label') : 'chromium'
assert(['chrome', 'chromium', 'brave', 'edge', 'opera'].includes(browserLabel), 'Known browser label required')
assert(!browserExecutable || process.argv.includes('--browser-label'), 'Explicit executable requires an explicit browser label')
assert(browserLabel === 'chromium' || browserExecutable, 'Branded browser requires its explicit executable')
const installViaCdp = process.argv.includes('--install-via-cdp')
const headed = process.argv.includes('--headed')
const fullBrowserRestart = process.argv.includes('--full-browser-restart')
for (const url of [apiUrl, sesUrl]) assert(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'Isolated loopback services only')
const webOrigin = 'http://127.0.0.1:5173', webDirectory = path.join(webSource, 'dist')
const extension = path.resolve('dist/chromium'), output = path.resolve('test-results/shared-unlock-identity')
const temporary = await mkdtemp(path.join(tmpdir(), 'palladin-identity-e2e-'))
let context, server, mailServer, page, popup, stage = 'preflight'
const checks = [], requests = []
const progress = setInterval(() => console.log(`PROGRESS ${JSON.stringify({ stage, completedChecks: checks.length })}`), 10000)
progress.unref()
const messages = [] // Synthetic SES v2 delivery, memory-only; never written to a report.
async function artifactHash(directory) {
  const hash = createHash('sha256')
  async function visit(relative) {
    for (const item of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, item.name)
      if (item.isDirectory()) await visit(name)
      else { assert(item.isFile(), 'Artifacts must contain only regular files'); hash.update(name); hash.update('\0'); hash.update(await readFile(path.join(directory, name))); hash.update('\0') }
    }
  }
  await visit(''); return hash.digest('hex')
}
const provenance = {
  webHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: webSource, encoding: 'utf8' }).trim(),
  extensionHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  webWorkingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: webSource, encoding: 'utf8' }).trim().length > 0,
  extensionWorkingTreeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  webArtifactSha256: await artifactHash(webDirectory), extensionArtifactSha256: await artifactHash(extension),
  platform: platform(), architecture: arch(), apiOrigin: new URL(apiUrl).origin, webOrigin,
  osRelease: release(), osVersion: platform() === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : release(), browserLabel, headed,
  browserExecutableSha256: browserExecutable ? createHash('sha256').update(await readFile(browserExecutable)).digest('hex') : null,
  extensionInstallation: installViaCdp ? 'browser-owned-cdp-loadUnpacked' : 'command-line-load-extension',
  distribution: 'local-unpacked', emailDelivery: 'local-ses-v2-fixture',
  delayedManualAuthorization: delayManualAuthorization,
  fullBrowserRestart,
}
const launchOptions = {
  ...(browserExecutable ? { executablePath: browserExecutable } : { channel: 'chromium' }), headless: !headed,
  ...(installViaCdp ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
  args: ['--remote-debugging-port=0', ...(installViaCdp ? ['--enable-unsafe-extension-debugging']
    : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`])],
}
async function observeLocalContext() {
  context.setDefaultTimeout(20000)
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return [webOrigin, new URL(apiUrl).origin, new URL(sesUrl).origin, 'http://localhost:54583'].includes(url.origin)
      || url.protocol === 'chrome-extension:' ? route.continue() : route.abort()
  })
  context.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === new URL(apiUrl).origin) requests.push({ stage, path: url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'), status: response.status() })
  })
}
const password = 'Synthetic!' + randomBytes(24).toString('base64url'), email = `cvt583-${randomBytes(8).toString('hex')}@example.test`
try {
  await mkdir(output, { recursive: true }); await rm(path.join(output, 'report.json'), { force: true })
  await rm(path.join(output, 'failure.json'), { force: true })
  assert.equal((await fetch(apiUrl + '/api/health')).status, 200)
  mailServer = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v2/email/outbound-emails') { response.writeHead(404); response.end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 262144) request.destroy() })
    request.on('end', () => {
      try {
        const message = JSON.parse(body)
        assert(message.Destination.ToAddresses.includes(email))
        assert.equal(typeof message.Content.Simple.Body.Html.Data, 'string')
        if (messages.length < 10) messages.push(message)
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ MessageId: randomBytes(16).toString('hex') }))
      } catch { response.writeHead(400); response.end() }
    })
  })
  await new Promise((resolve, reject) => { mailServer.once('error', reject); mailServer.listen(Number(new URL(sesUrl).port), '127.0.0.1', resolve) })
  const headers = Object.fromEntries((await readFile(path.join(webDirectory, '_headers'), 'utf8')).split('\n')
    .map(line => line.match(/^\s+([^:]+):\s*(.+)$/)).filter(Boolean).map(match => [match[1], match[2]]))
  assert(headers['Content-Security-Policy'])
  server = createServer((request, response) => {
    void (async () => {
      let file = path.resolve(webDirectory, '.' + new URL(request.url, webOrigin).pathname)
      if (!file.startsWith(webDirectory + path.sep)) file = path.join(webDirectory, 'index.html')
      let bytes
      try { bytes = await readFile(file) } catch { file = path.join(webDirectory, 'index.html'); bytes = await readFile(file) }
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)] ?? 'application/octet-stream'
      response.writeHead(200, { ...headers, 'Content-Type': mime, 'Cache-Control': 'no-store' }); response.end(bytes)
    })().catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5173, '127.0.0.1', resolve) })
  stage = 'browser-launch'
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), launchOptions)
  provenance.browserVersion = context.browser().version()
  if (installViaCdp) {
    stage = 'browser-installs-unpacked-extension'
    const browserCdp = await context.browser().newBrowserCDPSession()
    try {
      const installed = await browserCdp.send('Extensions.loadUnpacked', { path: extension })
      provenance.browserInstalledExtensionId = installed.id
    } finally { await browserCdp.detach() }
  }
  await observeLocalContext()
  let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'))
  const expected = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c,16)))
  assert.equal(extensionId, expected)
  if (installViaCdp) assert.equal(extensionId, provenance.browserInstalledExtensionId)
  page = await context.newPage()
  // Delay only transport, never the backend result or any session/key state.
  // This exposes the interval after local password verification but before
  // Identity replaces the previously locked logical session's authorization.
  if (delayManualAuthorization) await page.route(apiUrl + '/api/account/shared-unlock/authorizations', async route => {
    const started = performance.now()
    const delayed = stage === 'web-fresh-manual-unlock'
    if (delayed) {
      requests.push({ check: 'manual-authorization-request-delayed', delayMs: 1500 })
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    try {
      await route.continue()
      if (delayed) requests.push({ check: 'delayed-authorization-route-continued', elapsedMs: Math.round(performance.now() - started) })
    } catch {
      if (delayed) requests.push({ check: 'delayed-authorization-route-cancelled', elapsedMs: Math.round(performance.now() - started) })
    }
  })
  page.on('requestfailed', request => {
    const url = new URL(request.url())
    if (url.origin === new URL(apiUrl).origin) requests.push({ path: url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'), status: 'request-failed' })
  })
  stage = 'registration-credentials'; await page.goto(webOrigin + '/register')
  await page.locator('#register-email').fill(email)
  await page.locator('#register-password').fill(password)
  await page.locator('#register-password-confirm').fill(password)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  stage = 'registration-recovery'
  const words = await page.locator('ol.ph-no-capture li span.font-mono').allTextContents()
  assert.equal(words.length, 24)
  await page.getByRole('button', { name: "I've Saved My Recovery Key", exact: true }).click()
  const inputs = page.locator('input[id^="recovery-word-"]')
  await inputs.first().waitFor()
  for (let i = 0; i < await inputs.count(); i++) {
    const input = inputs.nth(i), index = Number((await input.getAttribute('id')).split('-').at(-1))
    await input.fill(words[index])
  }
  words.fill('')
  stage = 'registration-commit'
  const registered = page.waitForResponse(r => r.url() === apiUrl + '/api/auth/register')
  await page.getByRole('button', { name: 'Verify & Complete Setup', exact: true }).click()
  assert.equal((await registered).status(), 200)
  checks.push('actual-web-registration-with-browser-crypto')
  stage = 'local-email-verification'
  let verification
  for (let attempt = 0; attempt < 100 && !verification; attempt++) {
    verification = JSON.stringify(messages).match(/http:\/\/127\.0\.0\.1:5173\/verify-email\?token=[^"\\\s<]+/)?.[0]
    if (!verification) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert(verification, 'Local SES must contain this synthetic account verification')
  await page.goto(verification)
  await page.getByRole('heading', { name: 'Email Verified', exact: true }).waitFor()
  checks.push('actual-email-verification-through-local-ses')
  await page.waitForURL(url => url.pathname !== '/verify-email')
  stage = 'manual-web-login'
  if (new URL(page.url()).pathname !== '/login') {
    stage = 'manual-web-logout'
    // logoutAndReload clears auth first (SPA login route), then finishes its
    // closing/cleanup before replacing the document. Do not type into the
    // transient form that the real logout is still about to replace.
    const loggedOutDocument = page.waitForEvent('domcontentloaded')
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    await loggedOutDocument
  }
  stage = 'manual-web-login-fields'
  await page.waitForURL(url => url.pathname === '/login')
  await page.waitForLoadState('networkidle')
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(password)
  assert(await page.locator('#login-email').inputValue() === email, 'Login form must contain the complete synthetic email')
  assert(await page.locator('#login-password').inputValue() === password, 'Login form must contain the complete synthetic password')
  requests.push({ check: 'login-fields-after-fill', emailMatches: await page.locator('#login-email').inputValue() === email,
    passwordMatches: await page.locator('#login-password').inputValue() === password,
    submitEnabled: await page.getByRole('button', { name: /^Sign in$/i }).isEnabled() })
  stage = 'manual-web-login-submit'
  await page.getByRole('button', { name: /^Sign in$/i }).click()
  stage = 'manual-web-login-completion'
  await page.waitForURL(url => !['/login','/unlock'].includes(url.pathname))
  checks.push('actual-web-manual-password-login')
  stage = 'extension-automatic-unlock'
  popup = await openNativePopup(worker, path.join(temporary, 'profile'), extensionId)
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await popup.hasText('Unlocked')) break
    if (await popup.hasButton('Continue to Palladin')) { await popup.click('Continue to Palladin'); break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await popup.waitText('Unlocked')
  checks.push('actual-extension-automatic-unlock')
  await popup.waitText('No entries yet')
  checks.push('extension-authoritative-empty-snapshot-before-entry-creation')
  stage = 'web-create-entry'
  await page.getByRole('link', { name: 'Vaults', exact: true }).click()
  await page.getByText('Personal', { exact: true }).first().click()
  await page.getByRole('button', { name: 'Add Entry', exact: true }).first().click()
  const entryPassword = 'Entry!' + randomBytes(24).toString('base64url')
  for (const [selector, value] of [['#entry-label', 'Synthetic shared unlock proof'], ['#entry-username', 'synthetic-entry-user'], ['#entry-password', entryPassword]]) {
    await page.locator(selector).click(); await page.locator(selector).pressSequentially(value, { delay: 5 })
  }
  await page.getByRole('button', { name: 'Save Entry', exact: true }).click()
  await page.waitForURL(url => /^\/vaults\/[^/]+\/entries\/[^/]+$/.test(url.pathname))
  const [, , vaultId, , entryId] = new URL(page.url()).pathname.split('/')
  checks.push('actual-web-encrypted-entry-created')
  stage = 'live-entry-invalidation-after-empty-snapshot'
  await popup.waitText('Synthetic shared unlock proof')
  assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword), 'Live Entry invalidation must make the real Entry decryptable without relocking')
  checks.push('live-entry-invalidation-and-decryption-without-relocking')
  // A new manual authorization also exercises shared lock and unlock snapshot.
  stage = 'web-manual-lock-propagates'
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await popup.waitButton('Unlock')
  checks.push('web-manual-lock-propagated-to-extension')
  stage = 'web-fresh-manual-unlock'
  await page.locator('#unlock-password').click()
  await page.locator('#unlock-password').pressSequentially(password, { delay: 5 })
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  await popup.waitText('Unlocked')
  checks.push('extension-automatically-unlocked-after-new-manual-authorization')
  stage = 'extension-entry-list'
  await popup.waitText('Synthetic shared unlock proof')
  stage = 'extension-entry-decryption'
  assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword), 'Native popup must decrypt the actual Entry')
  checks.push('actual-extension-entry-password-decrypted')
  stage = 'extension-survives-web-close'
  await page.close(); page = undefined
  assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword), 'Completed extension session must survive Web closure')
  checks.push('extension-entry-decryption-after-web-close')
  stage = 'reopened-web-automatic-unlock'
  page = await context.newPage(); await page.goto(webOrigin + '/unlock')
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  checks.push('reopened-web-automatically-unlocked-by-extension')
  stage = 'browser-stops-extension-worker'
  await page.bringToFront()
  requests.push({ check: 'restart-source-visible', visible: await page.evaluate(() => document.visibilityState === 'visible') })
  const cdp = await context.newCDPSession(page)
  const versions = new Map()
  let stoppedByBrowser = false
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) {
      versions.set(version.versionId, version)
      if (version.scriptURL.startsWith(`chrome-extension://${extensionId}/`) && version.runningStatus === 'stopped') stoppedByBrowser = true
      if (version.scriptURL.startsWith(`chrome-extension://${extensionId}/`)) requests.push({ check: 'browser-worker-lifecycle', runningStatus: version.runningStatus, status: version.status })
    }
  })
  await cdp.send('ServiceWorker.enable')
  let version
  for (let attempt = 0; attempt < 100 && !version; attempt++) {
    version = [...versions.values()].find(v => v.scriptURL === worker.url() && v.runningStatus === 'running')
    if (!version) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(version, 'Browser must expose the actual running extension worker')
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId })
  // Keep the source Web document alive: its existing channel reconnect wakes
  // MV3. Reloading it here would deliberately destroy the only remaining keys.
  await cdp.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${extensionId}/` })
  for (let attempt = 0; attempt < 200; attempt++) {
    if (stoppedByBrowser && versions.get(version.versionId)?.runningStatus === 'running') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(stoppedByBrowser && versions.get(version.versionId)?.runningStatus === 'running', 'Browser must confirm stopped then running')
  worker = null // Reattach the actual CDP target, not Playwright's stale wrapper.
  checks.push('browser-stopped-and-restarted-extension-worker')
  await cdp.detach()
  stage = 'restarted-extension-automatic-unlock'
  popup.close(); popup = await openNativePopup(worker, path.join(temporary, 'profile'), extensionId)
  await popup.waitText('Unlocked')
  await popup.waitText('Synthetic shared unlock proof')
  assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword), 'Restarted worker must freshly unlock and decrypt the actual Entry')
  checks.push('restarted-extension-automatically-unlocked-and-decrypted-entry')
  if (fullBrowserRestart) {
    stage = 'full-browser-close-while-both-unlocked'
    const previousBrowser = context.browser()
    popup.close(); popup = undefined
    await context.close()
    assert.equal(previousBrowser.isConnected(), false, 'Previous browser must finish closing')
    page = undefined; worker = null
    checks.push('browser-closed-with-both-clients-unlocked')
    stage = 'full-browser-reopen-same-profile'
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), launchOptions)
    assert.equal(context.browser().version(), provenance.browserVersion)
    await observeLocalContext()
    page = await context.newPage(); await page.goto(webOrigin + '/unlock')
    stage = 'wake-persisted-extension-after-browser-restart'
    const restartCdp = await context.newCDPSession(page)
    try {
      await restartCdp.send('ServiceWorker.enable')
      await restartCdp.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${extensionId}/` })
      requests.push({ check: 'browser-woke-persisted-extension-after-full-restart' })
      let nativeWorker
      for (let attempt = 0; attempt < 100 && !nativeWorker; attempt++) {
        nativeWorker = (await restartCdp.send('Target.getTargets')).targetInfos.find(info =>
          info.type === 'service_worker' && info.url === `chrome-extension://${extensionId}/${manifest.background.service_worker}`)
        if (!nativeWorker) await new Promise(resolve => setTimeout(resolve, 100))
      }
      requests.push({ check: 'browser-observed-persisted-extension-worker', present: !!nativeWorker })
      assert(nativeWorker, 'Browser must expose the actual persisted extension worker target')
    } finally { await restartCdp.detach() }
    worker = null // The native target is authoritative; Playwright may miss its attach event.
    // Reuse the actual persisted installation and profile; no reinstall,
    // storage edit, logout or lock command may cause this locked state.
    await page.locator('#unlock-password').waitFor()
    popup = await openNativePopup(worker, path.join(temporary, 'profile'), extensionId)
    await popup.waitButton('Unlock')
    stage = 'full-browser-restart-rejects-key-use'
    for (let attempt = 0; attempt < 6; attempt++) {
      assert(await page.locator('#unlock-password').isVisible(), 'Web must not restore keys after browser closure')
      assert(await popup.revealDeniedWhileLocked(vaultId, entryId), 'Actual Entry reveal must be denied by the locked worker')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    checks.push('same-profile-restart-requires-manual-unlock-and-denies-entry-reveal')
    stage = 'manual-unlock-after-full-browser-restart'
    await page.locator('#unlock-password').fill(password)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
    await popup.waitText('Unlocked')
    await popup.waitText('Synthetic shared unlock proof')
    assert(await popup.revealedFieldMatches(vaultId, entryId, 'password', entryPassword), 'One manual unlock must restore the peer through a fresh handoff')
    checks.push('one-manual-unlock-after-browser-restart-restores-peer-entry-decryption')
  }
  stage = 'extension-manual-lock-propagates'
  popup.close(); popup = await openNativePopup(worker, path.join(temporary, 'profile'), extensionId)
  await popup.click('Lock')
  await page.locator('#unlock-password').waitFor()
  checks.push('extension-manual-lock-propagated-to-web')
  stage = 'manual-unlock-before-shared-logout'
  await page.locator('#unlock-password').click()
  await page.locator('#unlock-password').pressSequentially(password, { delay: 5 })
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.getByRole('link', { name: 'Vaults', exact: true }).waitFor()
  await popup.waitText('Unlocked')
  stage = 'extension-logout-propagates'
  const signoutClick = await popup.click('Sign out')
  requests.push({ check: 'native-popup-signout-click-observed', attempts: signoutClick.attempts })
  await page.locator('#login-email').waitFor()
  checks.push('extension-logout-propagated-to-web')
  await writeEvidence('report', { status: 'partial-pass', checks, requests,
    observedAt: new Date().toISOString(), browser: context.browser().version(), provenance, fullMatrix: false, entryDecryptionVerified: true })
  console.log(`PARTIAL: ${checks.length} native Identity/Entry checks; full matrix still required.`)
} catch (error) {
  if (popup) {
    const flags = {}
    for (const label of ['Unlocked', 'No entries yet', 'Try again', "Couldn't reach Palladin", "Couldn't open the encrypted Vault", "Couldn't open one of the encrypted entry indexes", 'Your session changed', 'One password manager works best', 'Sign in', 'Unlock']) {
      try { flags[label] = await popup.hasText(label) } catch { flags[label] = null }
    }
    requests.push({ check: 'native-popup-error-presentation', flags })
  }
  await writeEvidence('failure', { stage, checks, requests, errorType: error.name,
    timeout: error.name === 'TimeoutError' ? error.message.split('\n')[0] : undefined,
    pagePath: page ? new URL(page.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id') : null, provenance, observedAt: new Date().toISOString() })
  console.error(`FAIL at ${stage}; value-free failure.json recorded.`); process.exitCode = 1
} finally {
  clearInterval(progress)
  popup?.close()
  await context?.close()
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (mailServer?.listening) { mailServer.closeAllConnections(); await new Promise(resolve => mailServer.close(resolve)) }
  await rm(temporary, { recursive: true, force: true })
}

async function writeEvidence(kind, value) {
  const contents = JSON.stringify(value, null, 2)
  await writeFile(path.join(output, `${kind}.json`), contents)
  const version = String(provenance.browserVersion ?? 'launch').replace(/[^a-zA-Z0-9.-]/g, '_')
  const scenario = fullBrowserRestart ? '.full-browser-restart' : ''
  await writeFile(path.join(output, `${kind}.${browserLabel}-${version}${scenario}.json`), contents)
}
