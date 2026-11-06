import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs'
import { openNativePopup } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

// Synthetic setup, credential and API. This does not claim real-site acceptance.
const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const locale = process.env.CAPTURE_LOCALE ?? 'en'
const theme = process.env.CAPTURE_THEME ?? 'light'
assert(['en','pl'].includes(locale)); assert(['light','dark'].includes(theme))
const copy = JSON.parse(await readFile(new URL(`../../src/popup/locales/${locale}.json`, import.meta.url), 'utf8'))
const output = process.env.CAPTURE_LOCALE || process.env.CAPTURE_THEME
  ? `test-results/inline-capture-totp/${locale}-${theme}` : 'test-results/inline-capture-totp'
const api = await createCaptureApi()
await mkdir(output, {recursive:true});
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-totp-'))
const seed = 'JBSWY3DPEHPK3PXP'
const uri = `otpauth://totp/Synthetic:alice?secret=${seed}&issuer=Synthetic`
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
  await worker.evaluate(({locale,theme}) => chrome.storage.local.set({'palladin.ui.preferences':{language:locale,theme}}), {locale,theme})
  const page = await context.newPage(); await page.goto('https://capture.example.test/setup')
  await wait(() => page.locator('palladin-capture').count(), 'closed notice')
  assert.equal(await page.locator('palladin-capture').evaluate(host => host.shadowRoot), null)

  const cdp = await context.newCDPSession(page);
  const nodes = (await cdp.send('Accessibility.getFullAXTree')).nodes;
  const review = nodes.find(n => n.role?.value === 'button' && n.name?.value === copy['captureReview.review']);
  assert(review, 'Review present in closed notice');
  const {model} = await cdp.send('DOM.getBoxModel', {backendNodeId: review.backendDOMNodeId});
  await page.screenshot({path:`${output}/notice.png`});
  await page.mouse.click((model.content[0]+model.content[4])/2,(model.content[1]+model.content[5])/2);
  await wait(() => page.frames().some(f => f.url().includes('/capture-review/')), 'inline extension frame');
  const frame = page.frames().find(f => f.url().includes('/capture-review/'));
  await frame.getByText(copy['captureReview.createLogin'], {exact:true}).waitFor();
  await frame.getByText(copy['captureReview.createLogin'], {exact:true}).click();
  await frame.getByRole('textbox', {name:copy['totpCapture.name'],exact:true}).fill('Synthetic inline account');
  await wait(() => frame.evaluate(({locale,theme}) => document.documentElement.lang===locale && document.documentElement.dataset.theme===theme,{locale,theme}), 'review locale and theme');
  await page.waitForTimeout(800);
  await page.screenshot({path:`${output}/review.png`});
  await frame.getByRole('button', {name:copy['totpCapture.save'],exact:true}).click();
  await wait(() => api.writes.length===1,'inline encrypted save');
  assert.equal((await api.decrypt(api.writes[0])).content.totp.secret, seed);
  assert(!JSON.stringify(api.writes[0].request).includes(seed));
  await frame.getByRole('button',{name:copy['captureReview.done'],exact:true}).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({path:`${output}/saved.png`});
  assert.equal(await page.evaluate(() => document.body.innerText.includes('Synthetic inline account')),false,'page cannot read frame review');
  assert.deepEqual(api.errors,[]);
  console.log(`PASS: ${locale}/${theme} isolated inline TOTP review, encrypted save and no plaintext in host page`);
} finally { popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true }) }
