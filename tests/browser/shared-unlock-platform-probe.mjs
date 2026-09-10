import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, platform, arch } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const origin = 'https://panel.shared-unlock.test'
const root = await mkdtemp(path.join(tmpdir(), 'palladin-shared-unlock-probe-'))
const outputDirectory = path.resolve('test-results/shared-unlock-platform-probe')
const output = path.join(outputDirectory, 'report.json')
const manifestKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const evidence = { scope: 'synthetic-unpacked-chromium-probe', platform: platform(), arch: arch(),
  observedAt: new Date().toISOString(), productionSupport: false, containsUserData: false, observations: [] }
let context

try {
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  const reference = await createFixture('reference', false)
  const substituted = await createFixture('substituted', true)
  assert.notEqual(reference.digest, substituted.digest)
  const originalProfile = path.join(root, 'reference-profile')
  const first = await inspect(reference.directory, originalProfile)
  const second = await inspect(substituted.directory, path.join(root, 'substituted-profile'))
  assert.equal(first.extensionId, second.extensionId)
  assert.deepEqual(first.webObservation, second.webObservation)
  assert.equal(first.actualInstallType, 'development')
  assert.equal(second.actualInstallType, 'development')
  assert.equal(second.webObservation.reply.installType, 'normal')
  assert.equal(second.implementationChanged, true)
  assert.equal(first.implementationChanged, false)

  const clonedProfile = path.join(root, 'cloned-profile')
  await cp(originalProfile, clonedProfile, { recursive: true,
    filter: (source) => !['SingletonLock', 'SingletonSocket', 'SingletonCookie'].includes(path.basename(source)) })
  const clone = await inspect(reference.directory, clonedProfile)
  assert.equal(clone.extensionId, first.extensionId)
  assert.equal(clone.persistedMarkerPresentOnStart, true)
  assert.equal(clone.volatileMarkerPresentOnStart, false)

  evidence.browser = first.browser
  evidence.fixtureDigests = { reference: reference.digest, substituted: substituted.digest }
  evidence.fixtureFileHashes = { reference: reference.fileHashes, substituted: substituted.fileHashes }
  evidence.observations.push(
    { check: 'different-worker-bytes-same-browser-assigned-extension-id', observed: true },
    { check: 'different-worker-bytes-same-web-visible-response-and-frame-origin', observed: true },
    { check: 'web-visible-normal-install-claim-from-unpacked-worker', observed: true },
    { check: 'allowed-https-top-frame-has-browser-sender-context', observed: true },
    { check: 'unlisted-origin-cannot-use-external-messaging', observed: true },
    { check: 'copied-synthetic-profile-preserves-local-marker-and-extension-id', observed: true },
    { check: 'copied-synthetic-profile-does-not-restore-worker-memory', observed: true },
  )
  evidence.conclusion = 'Extension ID, extension-frame origin, self-reported installType and a local marker do not independently attest the official artifact or original profile. No shared-unlock trust adapter is established by this probe.'
  await cp(reference.directory, path.join(outputDirectory, 'fixtures/reference'), { recursive: true })
  await cp(substituted.directory, path.join(outputDirectory, 'fixtures/substituted'), { recursive: true })
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
  console.log('PASS: seven synthetic platform observations; shared-unlock trust gate remains unproven.')
} finally {
  await context?.close()
  await rm(root, { recursive: true, force: true })
}

async function createFixture(name, changed) {
  const directory = path.join(root, name)
  await mkdir(directory)
  const files = {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Synthetic shared unlock platform probe',
      version: '1.0.0', key: manifestKey, permissions: ['storage'],
      background: { service_worker: 'worker.js' },
      externally_connectable: { matches: [origin + '/*'] },
      web_accessible_resources: [{ resources: ['bridge.html', 'bridge.js'], matches: [origin + '/*'] }] }),
    'worker.js': `globalThis.implementationChanged = ${changed};
globalThis.senderObservations = [];
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (message.kind !== 'probe' || sender.origin !== '${origin}' || sender.frameId !== 0) return;
  globalThis.senderObservations.push({ origin: sender.origin, frameId: sender.frameId,
    hasTab: Number.isInteger(sender.tab?.id), hasDocument: typeof sender.documentId === 'string' });
  reply({ kind: 'synthetic-response', installType: 'normal' });
});`,
    'bridge.html': '<!doctype html><script src="bridge.js"></script>',
    'bridge.js': `parent.postMessage({ kind: 'synthetic-frame' }, '${origin}');`,
  }
  for (const [file, body] of Object.entries(files)) await writeFile(path.join(directory, file), body)
  return { directory, digest: digest(JSON.stringify(files)),
    fileHashes: Object.fromEntries(Object.entries(files).map(([file, body]) => [file, digest(body)])) }
}

async function inspect(extension, profile) {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 })
  const extensionId = new URL(worker.url()).host
  const start = await worker.evaluate(async () => {
    const self = await chrome.management.getSelf()
    const stored = await chrome.storage.local.get('syntheticLinkMarker')
    const observed = { actualInstallType: self.installType, implementationChanged: globalThis.implementationChanged,
      persistedMarkerPresentOnStart: stored.syntheticLinkMarker === 'synthetic-local-link',
      volatileMarkerPresentOnStart: globalThis.syntheticVolatileMarker === 'synthetic-live-context' }
    await chrome.storage.local.set({ syntheticLinkMarker: 'synthetic-local-link' })
    globalThis.syntheticVolatileMarker = 'synthetic-live-context'
    return observed
  })
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(`chrome-extension://${extensionId}/`)) return route.continue()
    const requestOrigin = new URL(route.request().url()).origin
    if ([origin, 'https://unlisted.shared-unlock.test'].includes(requestOrigin)) {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic platform probe</title>' })
    }
    return route.abort()
  })
  const page = await context.newPage()
  await page.goto(origin)
  const webObservation = await page.evaluate(async ({ id, expectedOrigin }) => {
    const reply = await chrome.runtime.sendMessage(id, { kind: 'probe' })
    const frameOrigin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic extension frame timeout')), 5000)
      const frame = document.createElement('iframe')
      addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow || event.data?.kind !== 'synthetic-frame') return
        clearTimeout(timeout)
        resolve(event.origin)
      })
      frame.src = expectedOrigin + '/bridge.html'
      document.body.append(frame)
    })
    return { reply, frameOrigin, pageHasManagementApi: typeof chrome.management !== 'undefined' }
  }, { id: extensionId, expectedOrigin: `chrome-extension://${extensionId}` })
  assert.equal(webObservation.frameOrigin, `chrome-extension://${extensionId}`)
  assert.equal(webObservation.pageHasManagementApi, false)
  const senders = await worker.evaluate(() => globalThis.senderObservations)
  assert.deepEqual(senders, [{ origin, frameId: 0, hasTab: true, hasDocument: true }])
  await page.goto('https://unlisted.shared-unlock.test')
  const rejected = await page.evaluate(async (id) => {
    try { await chrome.runtime.sendMessage(id, { kind: 'probe' }); return false } catch { return true }
  }, extensionId)
  assert.equal(rejected, true)
  assert.equal(await worker.evaluate(() => globalThis.senderObservations.length), 1)
  const browser = context.browser()?.version() ?? await page.evaluate(() => navigator.userAgent)
  await context.close()
  context = undefined
  return { ...start, extensionId, webObservation, browser }
}
