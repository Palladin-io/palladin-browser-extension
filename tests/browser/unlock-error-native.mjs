import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs'
import { openNativePopup } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

// Synthetic setup, credential and API. This does not claim real-site acceptance.
const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const api = await createCaptureApi();
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-unlock-motion-'));
let context, popup;

try {
  const extension = path.join(profile, 'dist/chromium')
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024 })
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium'); await allowCaptureApi(extension, api.url)
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).host
  await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic fixture</title>' }))
  const onboarding = context.pages().find(p => p.url().includes('/onboarding/')) ?? await context.waitForEvent('page', { predicate: p => p.url().includes('/onboarding/') })
  await onboarding.close(); popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in')
  assert.equal((await popup.configureConnection({ name: 'Synthetic API', apiUrl: api.url, webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true)
  await popup.fill('input[type="email"]', api.email); await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in'); await popup.waitText('No entries yet.')
  await popup.click('Lock'); await popup.waitButton('Unlock'); await popup.waitHeight(292,292);
  await popup.fill('input[type="password"]','synthetic-wrong-password');
  await popup.observeResize(); await popup.click('Unlock');
  await popup.waitText('Incorrect master password.'); await popup.waitHeight(310,320);
  const samples=await popup.resizeSamples();
  assert(samples.some(s=>s.height>292&&s.height<310),'native popup animates intermediate heights');
  assert(samples.every(s=>s.scroll<=1||!['auto','scroll'].includes(s.overflow)),'native error never shows form scrollbar');
  assert(samples.every(s=>s.popupScroll<=1||!['auto','scroll'].includes(s.popupOverflow)),'outer popup never flashes a scrollbar');
  assert(samples.at(-1).scroll<=1,'native form fully fits');
  await popup.observeResize(); await popup.click('Unlock');
  const retry=await popup.resizeSamples();
  assert(retry.every(s=>s.height===samples.at(-1).height),'another wrong password keeps the error space stable throughout retry');
  await popup.fill('input[type="password"]',api.password,{replace:true}); await popup.click('Unlock'); await popup.waitText('No entries yet.');
  console.log('PASS installed Chromium: wrong master password smoothly expands native popup without scrollbar; retry unlock succeeds');
} finally { popup?.close(); await context?.close(); await api.close(); await rm(profile,{recursive:true,force:true}); }
