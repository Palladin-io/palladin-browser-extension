import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, platform, arch } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

// Builds the actual product artifact with explicit synthetic public configuration.
// No accounts, credentials, tokens, API server, runtime injection or patched bundle.
const webSourceIndex = process.argv.indexOf('--web-source')
if (webSourceIndex >= 0 && !process.argv[webSourceIndex + 1]) throw new Error('--web-source requires a Web repository path')
const webSource = webSourceIndex < 0 ? null : path.resolve(process.argv[webSourceIndex + 1])
let servedWeb = null
const protocol = 'palladin.shared-unlock.browser.v1'
const apiUrl = 'http://localhost:5000'
const extension = path.resolve('dist/chromium')
const outputDirectory = path.resolve('test-results/shared-unlock-chromium-channel')
const root = await mkdtemp(path.join(tmpdir(), 'palladin-chromium-channel-'))
const servers = []
let context
const checks = []
try {
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  const allowed = await serve()
  const wrongPort = await serve()
  const build = spawnSync(process.execPath, ['scripts/run-vite-target.mjs', 'build', 'chromium'], {
    env: { ...process.env, VITE_API_URL: apiUrl, VITE_POSTHOG_KEY: '',
      VITE_SHARED_UNLOCK_ENVIRONMENTS: JSON.stringify([{ apiUrl, webOrigin: allowed }]) },
    encoding: 'utf8', timeout: 120000,
  })
  await writeFile(path.join(outputDirectory, 'build.log'), (build.stdout ?? '') + (build.stderr ?? ''))
  assert.equal(build.status, 0, 'Product artifact build must pass; inspect build.log')
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'))
  assert(manifest.permissions.includes('webNavigation'))
  assert.deepEqual(manifest.externally_connectable.matches, ['http://127.0.0.1/*'])
  assert.deepEqual(manifest.externally_connectable.ids, [])
  context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 })
  const extensionId = new URL(worker.url()).host
  const derivedId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)))
  assert.equal(extensionId, derivedId)
  const page = await context.newPage()
  await page.goto(allowed)
  const first = await connect(page, extensionId)
  assert.equal(first.type, 'ready')
  assert.equal(first.apiUrl, apiUrl)
  assert.equal(first.webOrigin, allowed)
  assert.equal(first.extensionId, extensionId)
  assert.equal(first.webNonce, 'A'.repeat(43))
  assert.match(first.documentBinding, /^\d+\/[^/]+\/[A-Za-z0-9_-]{43}$/)
  checks.push('actual-product-worker-browser-id-and-document-bound-ready')

  await page.evaluate(() => history.pushState({}, '', '/vaults#same-document'))
  await page.waitForTimeout(150)
  assert.equal(await page.evaluate(() => globalThis.channelProbe.disconnected), false)
  checks.push('same-document-history-keeps-port')

  const firstBinding = first.documentBinding
  await page.reload()
  const refreshed = await connect(page, extensionId)
  assert.notEqual(refreshed.documentBinding.split('/')[1], firstBinding.split('/')[1])
  assert.notEqual(refreshed.channelId, first.channelId)
  checks.push('reload-uses-new-browser-document-and-channel')

  // Reconnect within the same document: channel nonce changes, document ID does not.
  await page.evaluate(() => { globalThis.previousProbe = globalThis.channelProbe })
  const reconnected = await connect(page, extensionId)
  assert.equal(reconnected.documentBinding.split('/')[1], refreshed.documentBinding.split('/')[1])
  assert.notEqual(reconnected.channelId, refreshed.channelId)
  await page.waitForFunction(() => globalThis.previousProbe.disconnected)
  checks.push('same-document-replacement-retires-old-port')

  const wrong = await context.newPage()
  await wrong.goto(wrongPort)
  assert.equal((await connect(wrong, extensionId)).type, 'disconnected')
  checks.push('coarse-manifest-host-does-not-authorize-wrong-port')
  await wrong.goto(allowed.replace('127.0.0.1', 'localhost'))
  assert.equal((await connect(wrong, extensionId)).type, 'unavailable')
  checks.push('unlisted-origin-has-no-external-channel')

  await page.evaluate(origin => { const iframe = document.createElement('iframe'); iframe.src = origin + '/frame'; document.body.append(iframe) }, allowed)
  const frame = await waitForFrame(page)
  assert.equal((await connect(frame, extensionId)).type, 'disconnected')
  assert.equal(await page.evaluate(() => globalThis.channelProbe.disconnected), false)
  checks.push('same-origin-iframe-rejected-without-closing-top-frame')

  await page.evaluate(() => globalThis.channelProbe.port.postMessage({ type: 'hello', protocol: 'palladin.shared-unlock.browser.v1',
    apiUrl: 'http://localhost:5000', webNonce: 'A'.repeat(43), accessToken: 'synthetic-no-authority' }))
  await page.waitForFunction(() => globalThis.channelProbe.disconnected)
  checks.push('expanded-or-repeated-frame-retires-channel')
  const malformed = await context.newPage()
  await malformed.goto(allowed)
  assert.equal((await connect(malformed, extensionId, { apiUrl: 'https://different.example.test' })).type, 'disconnected')
  checks.push('web-cannot-select-another-api-environment')

  if (webSource) {
    const webBuild = spawnSync('npm', ['run', 'build'], { cwd: webSource, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, VITE_API_URL: apiUrl, VITE_SHARED_UNLOCK_EXTENSION_ID: extensionId,
        VITE_GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
        VITE_SIGNALR_HUB_URL: apiUrl + '/hubs/notifications', VITE_PUBLIC_ASSET_URL: 'http://localhost:4566/palladin-local-public-assets',
        VITE_POSTHOG_KEY: '', VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_APP_ID: '', VITE_FIREBASE_VAPID_KEY: '' } })
    await writeFile(path.join(outputDirectory, 'web-build.log'), (webBuild.stdout ?? '') + (webBuild.stderr ?? ''))
    assert.equal(webBuild.status, 0, 'Web product build must pass; inspect web-build.log')
    const webDirectory = path.join(webSource, 'dist')
    const headers = Object.fromEntries((await readFile(path.join(webDirectory, '_headers'), 'utf8')).split('\n')
      .map(line => line.match(/^\s+([^:]+):\s*(.+)$/)).filter(Boolean).map(match => [match[1], match[2]]))
    assert(headers['Content-Security-Policy'])
    servedWeb = { directory: webDirectory, headers }
    for (const existing of context.pages()) await existing.close()
    // Value-free observation only: the wrapper calls the actual browser API and
    // leaves product bytes and native recipient selection unchanged.
    await context.addInitScript(() => {
      globalThis.applicationChannelProbe = []
      const runtime = globalThis.chrome?.runtime
      if (!runtime?.connect) return
      const original = runtime.connect
      runtime.connect = function (...args) {
        const port = original.apply(runtime, args)
        if (args[1]?.name === 'palladin.shared-unlock.browser.v1') {
          const observed = { extensionId: args[0], closed: false, ready: null, stateSent: false, stateReceived: false }
          globalThis.applicationChannelProbe.push(observed)
          const send = port.postMessage.bind(port), disconnect = port.disconnect.bind(port)
          const isSignedOutState = message => message?.type === 'operation' && message.payload?.kind === 'state'
            && message.payload.status === 'signed-out' && message.payload.accountId === null && message.payload.source === null
          port.postMessage = message => { if (isSignedOutState(message)) observed.stateSent = true; return send(message) }
          port.disconnect = () => { observed.closed = true; return disconnect() }
          port.onMessage.addListener(message => {
            if (message?.type === 'ready') observed.ready = { extensionId: message.extensionId, documentBinding: message.documentBinding }
            if (isSignedOutState(message)) observed.stateReceived = true
          })
          port.onDisconnect.addListener(() => { void runtime.lastError; observed.closed = true })
        }
        return port
      }
    })
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === allowed || url.protocol === 'chrome-extension:' ? route.continue() : route.abort()
    })
    const application = await context.newPage()
    const response = await application.goto(allowed + '/login')
    assert.equal(response.headers()['content-security-policy'], headers['Content-Security-Policy'])
    await application.waitForFunction(() => globalThis.applicationChannelProbe.some(item => item.ready && item.stateSent && item.stateReceived && !item.closed), { timeout: 15000 })
    const beforeReload = await application.evaluate(() => globalThis.applicationChannelProbe.find(item => item.ready && !item.closed))
    assert.equal(beforeReload.extensionId, extensionId)
    await application.reload()
    await application.waitForFunction(() => globalThis.applicationChannelProbe.some(item => item.ready && item.stateSent && item.stateReceived && !item.closed), { timeout: 15000 })
    const afterReload = await application.evaluate(() => globalThis.applicationChannelProbe.find(item => item.ready && !item.closed))
    assert.notEqual(afterReload.ready.documentBinding.split('/')[1], beforeReload.ready.documentBinding.split('/')[1])
    checks.push('actual-product-coordinators-exchange-signed-out-state')
    checks.push('actual-web-application-bootstrap-under-delivered-csp')
    checks.push('actual-web-application-reload-establishes-new-document-channel')
    await writeFile(path.join(outputDirectory, 'web-artifact-hashes.json'), JSON.stringify(await hashes(webDirectory), null, 2) + '\n')
  }

  const report = { scope: 'actual-configured-unpacked-chromium-product-channel', observedAt: new Date().toISOString(),
    platform: platform(), arch: arch(), browser: context.browser()?.version(), containsUserData: false,
    verifiesCryptoHandoff: false, distributedArtifactAcceptance: false, productionSupport: false,
    includesActualWebApplication: Boolean(webSource),
    artifactFileHashes: await hashes(extension), checks,
    limitations: 'Local Chromium only. No Identity session or MK handoff. Store artifacts, supported desktop matrix, Firefox and Safari remain unverified.' }
  await writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`PASS: ${checks.length} actual Chromium product channel checks; no crypto handoff or platform-matrix claim.`)
} finally {
  try { await context?.close() } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(root, { recursive: true, force: true })
  }
}

async function serve() {
  const server = createServer((request, response) => {
    void (async () => {
      if (!servedWeb) { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end('<!doctype html><title>Synthetic channel fixture</title><body>Channel fixture</body>'); return }
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      let file = path.resolve(servedWeb.directory, '.' + pathname)
      if (!file.startsWith(servedWeb.directory + path.sep)) file = path.join(servedWeb.directory, 'index.html')
      let bytes
      try { bytes = await readFile(file) } catch { file = path.join(servedWeb.directory, 'index.html'); bytes = await readFile(file) }
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] ?? 'application/octet-stream'
      response.writeHead(200, { ...servedWeb.headers, 'Content-Type': mime, 'Cache-Control': 'no-store' }); response.end(bytes)
    })().catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}
async function connect(pageOrFrame, extensionId, overrides = {}) {
  return pageOrFrame.evaluate(({ extensionId, protocol, apiUrl, overrides }) => new Promise(resolve => {
    if (!globalThis.chrome?.runtime?.connect) { resolve({ type: 'unavailable' }); return }
    const port = chrome.runtime.connect(extensionId, { name: protocol })
    const probe = { port, disconnected: false }; globalThis.channelProbe = probe
    const timer = setTimeout(() => { port.disconnect(); resolve({ type: 'timeout' }) }, 10000)
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; probe.disconnected = true; clearTimeout(timer); resolve({ type: 'disconnected' }) })
    port.onMessage.addListener(message => { clearTimeout(timer); resolve(message) })
    port.postMessage({ type: 'hello', protocol, apiUrl, webNonce: 'A'.repeat(43), ...overrides })
  }), { extensionId, protocol, apiUrl, overrides })
}
async function waitForFrame(page) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = page.frames().find(candidate => candidate.url().endsWith('/frame'))
    if (frame) return frame
    await page.waitForTimeout(20)
  }
  throw new Error('Synthetic child frame did not load')
}
async function hashes(directory, prefix = '') {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name; const file = path.join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await hashes(file, relative + '/'))
    else result[relative] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return result
}
