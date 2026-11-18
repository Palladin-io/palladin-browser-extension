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
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-mute-'));
const key = 'sk_test_SyntheticCapture001abcdefghijklmnopqrstuv'; // gitleaks:allow - synthetic fixture
const uri = 'otpauth://totp/Synthetic:alice?secret=JBSWY3DPEHPK3PXP&issuer=Synthetic';
let context, popup;
const wait = async (check, label) => { const end = Date.now() + 12000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw Error(`Timeout: ${label}`); };
try {
  const extension = path.join(profile, 'dist/chromium')
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024 })
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium'); await allowCaptureApi(extension, api.url)
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).host
  await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: fixture(new URL(route.request().url())) }))
  const onboarding = context.pages().find(p => p.url().includes('/onboarding/')) ?? await context.waitForEvent('page', { predicate: p => p.url().includes('/onboarding/') })
  await onboarding.close(); popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in')
  assert.equal((await popup.configureConnection({ name: 'Synthetic API', apiUrl: api.url, webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true)
  await popup.fill('input[type="email"]', api.email); await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in'); await popup.waitText('No entries yet.'); await popup.dismiss(); popup = null

  let page, cdp;
  async function clickOwned(name, role = 'button') {
    let node;
    await wait(async () => { node = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(n => !n.ignored && n.role?.value === role && (typeof name === 'string' ? n.name?.value === name : name.test(n.name?.value ?? ''))); return !!node; }, `owned ${role} ${String(name)}`);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
    await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
  }
  async function trigger(kind) {
    await page.goto(`https://app.example.test/${kind}`);
    if (kind === 'login') {
      await page.getByLabel('Username').fill('synthetic-user'); await page.getByLabel('Password').fill('SyntheticPassword!001');
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
    } else if (kind === 'card') {
      for (const [field, value] of [['cc-number','4111111111111111'],['cc-name','Synthetic Cardholder'],['cc-exp-month','12'],['cc-exp-year','2031'],['cc-csc','739']]) await page.locator(`[autocomplete="${field}"]`).fill(value);
      await page.getByRole('heading').click();
    } else if (kind === 'key') {
      await page.waitForTimeout(600); await page.getByRole('button', { name: 'Generate' }).click();
    } else if (kind === 'oauth') {
      await page.getByRole('link', { name: 'Continue with Google' }).click(); await page.getByRole('link', { name: 'Allow', exact: true }).click();
    }
  }
  async function mutedSites() {
    return worker.evaluate(async () => Object.values(await chrome.storage.local.get('palladin.capture-preferences.v1')).flat().flatMap(profile => profile.mutedSites));
  }
  for (const surface of ['notice','review']) for (const kind of ['login','key','card','oauth','totp']) {
    if (process.env.CAPTURE_MUTE_SCOPE && !process.env.CAPTURE_MUTE_SCOPE.split(',').includes(`${kind}-${surface}`)) continue;
    await page?.close();
    page = await context.newPage(); cdp = await context.newCDPSession(page);
    popup = await openNativePopup(worker, profile, extensionId);
    assert.equal(await popup.unmuteCaptureSite('example.test'), true);
    await popup.dismiss(); popup = null;
    await trigger(kind);
    await wait(() => page.locator('palladin-capture').count(), `${kind} notice`);
    assert.equal(await page.locator('palladin-capture').last().evaluate(host => host.shadowRoot), null);
    await page.waitForTimeout(700);
    if (surface === 'review') {
      await clickOwned('Review');
      await wait(() => page.frames().some(frame => frame.url().includes('/capture-review/')), 'review frame');
      const frame = page.frames().find(frame => frame.url().includes('/capture-review/'));
      await frame.locator('.capture-review[data-stage="review"]').waitFor();
      await page.waitForTimeout(700);
      await frame.getByRole('button', { name: 'More dismiss options', exact: true }).click();
      await frame.getByRole('menuitem', { name: /Don't offer to save on this site/ }).click();
    } else {
      await clickOwned('More dismiss options');
      await clickOwned(/Don't offer to save on this site/);
    }
    await wait(async () => (await mutedSites()).includes('example.test'), `${kind} ${surface} persisted mute`);
    assert.deepEqual(await mutedSites(), ['example.test'], 'only the worker-derived site was persisted');
    assert.equal(api.writes.length, 0, 'mute never writes an Entry');
    await wait(async () => await page.locator('palladin-capture').count() === 0, 'muted notification closes');
    await trigger(kind);
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('palladin-capture').count(), 0, `${kind}: later automatic notice stays suppressed`);
    assert.equal(api.writes.length, 0);
    console.log(`PASS: ${kind} ${surface} click persists source-bound mute, closes, suppresses later capture, no Entry write`);
  }
  assert.deepEqual(api.errors, []);
} finally { popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true }); }

function fixture(url) {
  const html = body => `<!doctype html><html><body><h1>Synthetic capture</h1>${body}</body></html>`;
  if (url.hostname === 'accounts.google.com') return html('<a href="https://app.example.test/callback?code=synthetic-code&state=synthetic-state">Allow</a>');
  if (url.pathname === '/oauth') return html('<a href="https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&redirect_uri=https%3A%2F%2Fapp.example.test%2Fcallback&state=synthetic-state">Continue with Google</a>');
  if (url.pathname === '/callback') return html('Signed in');
  if (url.pathname === '/totp') return html(`<a href="${uri}">Set up authenticator</a>`);
  if (url.pathname === '/card') return html('<form>' + ['cc-number','cc-name','cc-exp-month','cc-exp-year','cc-csc'].map(a => `<input autocomplete="${a}" type="${a === 'cc-csc' ? 'password' : 'text'}">`).join('') + '</form>');
  if (url.pathname === '/key') return html(`<section><h2>API key</h2><button onclick="document.querySelector('output').textContent='${key}'">Generate</button><output></output></section>`);
  return html(`<form><label>Username<input autocomplete="username" name="username"></label><label>Password<input type="password" autocomplete="current-password" name="password"></label><button type="submit">Submit</button></form><script>document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('form').outerHTML='<div role="status">Successfully signed in</div>'});</script>`);
}
