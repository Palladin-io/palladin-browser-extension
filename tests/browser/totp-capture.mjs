import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs'
import { openNativePopup } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

// Synthetic setup, credential and API. This does not claim real-site acceptance.
const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const api = await createCaptureApi()
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-totp-'))
const seed = 'JBSWY3DPEHPK3PXP', nextSeed = 'KRSXG5DSNFXGOIDB'
const uri = `otpauth://totp/Synthetic:alice?secret=${seed}&issuer=Synthetic`
const qr = (await readFile('tests/browser/fixtures/totp-setup.png')).toString('base64')
const originalQr = (await readFile('tests/browser/fixtures/totp-setup-original.png')).toString('base64')
let context, popup
const wait = async (check, label) => { const end = Date.now() + 12000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)) } throw Error(`Timeout: ${label}`) }
try {
  const extension = path.join(profile, 'dist/chromium')
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024 })
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium'); await allowCaptureApi(extension, api.url)
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).host
  await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: `<html><body><h1>Authenticator setup</h1>${route.request().url().includes('/blank') ? '' : `<a href="${uri}">Set up</a>`}</body></html>` }))
  const onboarding = context.pages().find(p => p.url().includes('/onboarding/')) ?? await context.waitForEvent('page', { predicate: p => p.url().includes('/onboarding/') })
  await onboarding.close(); popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in')
  assert.equal((await popup.configureConnection({ name: 'Synthetic API', apiUrl: api.url, webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true)
  await popup.fill('input[type="email"]', api.email); await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in'); await popup.waitText('No entries yet.'); await popup.dismiss(); popup = null
  const page = await context.newPage(); await page.goto('https://capture.example.test/setup')
  await wait(() => page.locator('palladin-capture').count(), 'closed notice')
  assert.equal(await page.locator('palladin-capture').evaluate(host => host.shadowRoot), null)
  popup = await openNativePopup(worker, profile, extensionId); await popup.waitText('Save authenticator')
  await popup.screenshot('/tmp/cvt-737-totp-popup.png')
  const selector = 'section[aria-label="Save authenticator"] select'
  await popup.select(selector, await popup.optionValue(selector, 1)); await popup.fill('section[aria-label="Save authenticator"] input', 'Synthetic account')
  await popup.click('Save authenticator'); await wait(() => api.writes.length === 1, 'encrypted create')
  const first = await api.decrypt(api.writes[0]); assert.equal(first.content.totp.secret, seed)
  assert(!JSON.stringify(api.writes[0].request).includes(seed))
  await popup.dismiss(); popup = null
  await page.goto('https://capture.example.test/other'); await page.evaluate(qr => { document.querySelector('a').remove(); const img = new Image(); img.src = `data:image/png;base64,${qr}`; document.body.append(img) }, qr)
  await wait(() => page.locator('palladin-capture').count(), 'QR notice')
  popup = await openNativePopup(worker, profile, extensionId); await popup.waitText('Save authenticator')
  assert(await popup.hasText('Replace existing authenticator'))
  await popup.click('Save authenticator'); assert.equal(api.writes.length, 1, 'replacement requires confirmation')
  await popup.click('Replace existing authenticator', 'checkbox'); await popup.click('Save authenticator')
  await wait(() => api.writes.length === 2, 'encrypted update')
  const updated = await api.decrypt(api.writes[1]); assert.equal(updated.content.totp.secret, nextSeed)
  assert.equal(updated.memberLabel, first.memberLabel); assert.equal(updated.content.username, first.content.username)
  assert(!JSON.stringify(api.writes[1].request).includes(nextSeed))
  await popup.dismiss(); popup = null; await page.goto('https://capture.example.test/blank');
  popup = await openNativePopup(worker, profile, extensionId); await popup.click('Scan QR on page');
  await popup.waitText('No readable authenticator setup found on this page.'); await popup.dismiss(); popup = null
  await page.evaluate(([firstUri, secondUri]) => { for (const uri of [firstUri, secondUri]) { const a = document.createElement('a'); a.href = uri; a.textContent = 'setup'; document.body.append(a) } }, [uri, uri.replace(seed, nextSeed)])
  await new Promise(resolve => setTimeout(resolve, 600)); popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Scan QR on page'); await popup.waitText('Multiple authenticator setups found.')
  assert.equal(api.writes.length, 2, 'ambiguous scan performs no write')
  await popup.dismiss(); popup = null; await page.goto('https://canvas.capture.example.test/blank')
  await page.evaluate(async ([firstQr, secondQr]) => {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256; document.body.append(canvas)
    const images = await Promise.all([firstQr, secondQr].map(encoded => new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = `data:image/png;base64,${encoded}`
    })))
    globalThis.syntheticQrImages = images
  }, [qr, originalQr])
  await new Promise(resolve => setTimeout(resolve, 900))
  await page.evaluate(() => { document.querySelector('canvas').getContext('2d').drawImage(globalThis.syntheticQrImages[0], 0, 0) })
  await wait(() => page.locator('palladin-capture').count(), 'canvas-only automatic discovery')
  popup = await openNativePopup(worker, profile, extensionId); await popup.waitText('Save authenticator')
  await popup.select(selector, await popup.optionValue(selector, 1)); await popup.fill('section[aria-label="Save authenticator"] input', 'Canvas draft')
  await page.evaluate(() => document.body.append(document.createElement('span')))
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(await popup.inputValue('section[aria-label="Save authenticator"] input'), 'Canvas draft', 'unrelated mutation preserves native draft')
  await page.evaluate(() => { document.querySelector('canvas').getContext('2d').drawImage(globalThis.syntheticQrImages[1], 0, 0) })
  await popup.click('Save authenticator')
  await new Promise(resolve => setTimeout(resolve, 7_000)) // Outlast the icon resolver and its timeout before asserting no mutation.
  assert.equal(api.writes.length, 2, 'pixel-only canvas change blocks stale save')
  await popup.click('Scan QR on page'); await popup.waitText('Save authenticator')
  await popup.select(selector, await popup.optionValue(selector, 1)); await popup.fill('section[aria-label="Save authenticator"] input', 'Canvas current')
  await popup.click('Save authenticator'); await wait(() => api.writes.length === 3, 'unchanged current canvas can save')
  const canvasSaved = await api.decrypt(api.writes[2]); assert.equal(canvasSaved.content.totp.secret, seed)

  const storage = JSON.stringify(await worker.evaluate(async () => {
    const stores = []
    for (const info of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open(info.name); request.onsuccess = () => resolve(request.result); request.onerror = reject })
      for (const name of db.objectStoreNames) stores.push(await new Promise((resolve, reject) => {
        const request = db.transaction(name, 'readonly').objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = reject
      }))
      db.close()
    }
    return [await chrome.storage.local.get(null), await chrome.storage.session.get(null), await chrome.storage.sync.get(null), stores]
  }))
  assert(!storage.includes(seed) && !storage.includes(nextSeed) && !storage.includes(qr) && !storage.includes(originalQr))
  assert(await popup.webStorageExcludes([seed, nextSeed, qr, originalQr]))
  assert.deepEqual(api.errors, [])
  console.log('PASS: synthetic URI create, locally decoded QR, confirmed replacement, manual no-result/ambiguity, canvas-only detection, stale pixel rejection, draft stability and storage exclusion')
} finally { popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true }) }
