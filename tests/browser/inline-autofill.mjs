import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import * as crypto from '@palladin/crypto';
import { createCaptureApi } from './capture-api.mjs';
import { openNativePopup } from './native-popup.mjs';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';

// Actual built worker/isolated script/closed UI and client crypto. Provider and
// account values are synthetic. Captured page structure has synthetic CSS and
// handlers: these tests are not evidence of a live service login.
const api = await createCaptureApi();
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-inline-'));
let context, popup;
const username = 'synthetic@example.test';
const password = 'Synthetic-inline-password!42';
const proton = await readFile('tests/fixtures/forms/proton-login-2026-09-20/page.html', 'utf8');
const linkedin = await readFile('tests/fixtures/forms/linkedin-login-2026-09-20/page.html', 'utf8');
const aws = await readFile('tests/fixtures/forms/aws-root-identifier-2026-09-20/page.html', 'utf8');
const jetbrains = await readFile('tests/fixtures/forms/jetbrains-identifier-2026-09-20/page.html', 'utf8');
try {
  const vault = api.vaults[0];
  for (const host of ['proton.example.test', 'jetbrains.example.test', 'linkedin.example.test', 'aws.example.test']) {
    const entryId = randomUUID();
    const secret = { schema: 'palladin.member-secret.v1', entryType: 'credential', memberLabel: host,
      agentLabel: null, discoverable: false, description: null, icon: null, color: null, agentFieldAccess: { memberLabel: 'never', agentLabel: 'never', description: 'never', icon: 'never', color: 'never',
        entryType: 'never', 'credential.username': 'never', 'credential.password': 'never', 'credential.url': 'never',
        'credential.urlDomain': 'never', 'credential.totp': 'never', notes: 'never' },
      content: { username, password, url: `https://${host}/login`, urlDomain: host, totp: null, notes: null, customFields: [] } };
    const material = await crypto.sealCanonicalEntry({ organizationId: vault.detail.organizationId,
      vaultId: vault.detail.id, entryId, revision: '1', vaultKeyVersion: 1, vdkVersion: 1, memberKeyGeneration: 1 },
    secret, vault.vaultKey, vault.discoveryKey, 1);
    vault.entries.set(entryId, { ...material, id: entryId, organizationId: vault.detail.organizationId, vaultId: vault.detail.id,
      state: 'active', currentRevision: '1', memberIndexRevision: '1', currentKeyVersion: 1,
      agentDiscoveryRevision: null, agentDiscoveryRevisionHighWatermark: '0', deliveryPolicy: 'standard',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  vault.detail.memberSequence = '5'; vault.detail.entryCount = 4;
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  await context.route('https://**/*', route => {
    const host = new URL(route.request().url()).hostname;
    if (!host.endsWith('.example.test')) return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<style>body{margin:60px}form{width:450px}input:not([type=checkbox]){display:block;width:400px;height:40px;margin:12px 0}button{min-height:35px}</style>${host.startsWith('proton') ? proton : host.startsWith('linkedin') ? linkedin : jetbrains}<script>globalThis.submissions=0;document.querySelector('form')?.addEventListener('submit',event=>{event.preventDefault();globalThis.submissions++})</script>` });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const onboarding = context.pages().find(page => page.url().includes('/onboarding/'))
    ?? await context.waitForEvent('page', { predicate: page => page.url().includes('/onboarding/') });
  await onboarding.close();
  popup = await openNativePopup(worker, profile, extensionId);
  await popup.click('Continue to Palladin'); await popup.fill('input[type="email"]', api.email);
  await popup.fill('input[type="password"]', api.password); await popup.click('Sign in');
  await popup.waitText('proton.example.test');
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const wait = async (check, label) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
    throw new Error(`Inline browser regression timed out: ${label}`);
  };
  const click = async name => {
    let node;
    await wait(async () => {
      node = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(node => !node.ignored && node.role?.value === 'button' && node.name?.value === name);
      return Boolean(node);
    }, name);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
    await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
  };
  const aligned = async selector => {
    await wait(() => page.evaluate(selector => {
      const input = document.querySelector(selector) ?? document.querySelector('#component')?.shadowRoot?.querySelector(selector), host = document.querySelector('palladin-autofill');
      if (!input || !host) return false;
      const field = input.getBoundingClientRect(), shield = host.getBoundingClientRect();
      return shield.width > 0 && Math.abs(field.top + field.height / 2 - shield.top - shield.height / 2) < 1
        && shield.right < field.right && shield.left > field.left;
    }, selector), `shield aligned to ${selector}`);
  };
  // Observed AWS structure, synthetic framework handlers. Real AWS uses a
  // type=submit Next with a click handler; requestSubmit skips that handler.
  const awsRequests = [];
  await page.route('https://aws.example.test/**', route => {
    const url = new URL(route.request().url());
    awsRequests.push({ method: route.request().method(), hasQuery: url.search !== '' });
    const unsafe = url.pathname === '/unsafe';
    const markup = unsafe ? '<form><input id="username" name="username" autocomplete="username"><input id="password" name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>' : aws;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<style>body{margin:40px}form{width:450px}input:not([type=radio]){display:block;width:400px;height:40px;margin:12px}button{min-height:35px}</style>${markup}<script>
      globalThis.nextClicks=0;globalThis.submitEvents=0;globalThis.blockedDefault=false;
      document.querySelector('form').addEventListener('submit',event=>{globalThis.submitEvents++;globalThis.blockedDefault=event.defaultPrevented});
      ${unsafe ? '' : "document.querySelector('#next_button').addEventListener('click',event=>{event.preventDefault();globalThis.nextClicks++;document.querySelector('#resolving_input').form.innerHTML='<input id=next-password type=password autocomplete=current-password><button type=submit>Sign in</button>'})"}
      </script>` });
  });
  await page.goto('https://aws.example.test/login');
  await wait(async () => await page.locator('#resolving_input').inputValue() === username, 'AWS observed identifier automatic fill');
  await click('Open Palladin suggestions'); await click(`Fill and log in: ${username}`);
  await wait(() => page.evaluate(() => globalThis.nextClicks === 1), 'AWS native Next click handler');
  assert.equal(await page.evaluate(() => globalThis.submitEvents), 0);
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.deepEqual(awsRequests, [{ method: 'GET', hasQuery: false }]);
  await page.goto('https://aws.example.test/unsafe');
  await wait(async () => await page.locator('#password').inputValue() === password, 'synthetic default GET password form fill');
  await click('Open Palladin suggestions'); await click(`Fill and log in: ${username}`);
  await wait(() => page.evaluate(() => globalThis.submitEvents === 1), 'native GET submit event');
  assert.equal(await page.evaluate(() => globalThis.blockedDefault), true);
  await page.waitForTimeout(150);
  assert.equal(new URL(page.url()).pathname, '/unsafe');
  assert.deepEqual(awsRequests, [{ method: 'GET', hasQuery: false }, { method: 'GET', hasQuery: false }]);
  console.log('PASS: observed AWS native Next click and synthetic default-GET credential protection');
  await page.goto('https://proton.example.test/login');
  await wait(async () => await page.locator('#password').inputValue() === password, 'automatic exact-host fill');
  assert.equal(await page.evaluate(() => globalThis.submissions), 0);
  await aligned('#username');
  await page.locator('#username').focus(); await click('Open Palladin suggestions');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'PALLADIN-AUTOFILL');
  await click(`Fill and log in: ${username}`);
  await wait(() => page.evaluate(() => globalThis.submissions === 1), 'matching autofill explicit submit');
  await page.locator('#username').fill('other-manager@example.test'); await page.locator('#password').fill('Other-synthetic-password!');
  await click('Open Palladin suggestions'); await click(`Fill and log in: ${username}`);
  await wait(() => page.evaluate(() => globalThis.submissions === 2), 'explicit account replacement submit');
  assert.equal(await page.locator('#username').inputValue(), username); assert.equal(await page.locator('#password').inputValue(), password);
  await page.evaluate(() => { const error = document.createElement('div'); error.textContent = 'Synthetic account validation error'; error.style.height = '90px'; document.querySelector('form').prepend(error); });
  await aligned('#username');
  await page.evaluate(() => { document.querySelector('form').style.display = 'none'; });
  await wait(() => page.locator('palladin-autofill').count().then(count => count === 0), 'hidden form drops shield');
  await page.evaluate(() => { document.querySelector('form').style.display = ''; }); await aligned('#username');
  console.log('PASS: real Chromium automatic/manual refill, explicit replacement, focus, layout error and visibility recovery');
  await page.goto('https://jetbrains.example.test/login');
  await wait(async () => await page.locator('#email').inputValue() === username, 'observed identifier stage fill'); await aligned('#email');
  await page.evaluate(() => { document.querySelector('form').innerHTML = '<input id="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button>'; });
  await wait(async () => await page.locator('#password').inputValue() === password, 'synthetic password stage fill'); await aligned('#password');
  assert.equal(await page.locator('palladin-autofill').count(), 1);
  console.log('PASS: observed JetBrains identifier structure and synthetic password transition keep one aligned shield');
  await page.goto('https://jetbrains.example.test/shadow');
  await page.evaluate(() => {
    document.body.replaceChildren();
    const component = document.createElement('div'); component.id = 'component';
    const root = component.attachShadow({ mode: 'open' });
    const controls = '<input id="shadow-username" autocomplete="username"><input id="shadow-password" type="password" autocomplete="current-password"><button type="button">Sign in</button>';
    root.innerHTML = '<style>input{display:block;width:400px;height:40px;margin:12px}section{width:450px}</style><section>' + controls + '</section><section hidden>' + controls + '</section>';
    root.querySelector('button').addEventListener('click', () => { globalThis.submissions++; });
    document.body.append(component);
  });
  await wait(async () => await page.locator('#component input[type="password"]').first().inputValue() === password, 'open-root formless fill');
  await aligned('#shadow-username');
  assert.equal(await page.locator('palladin-autofill').count(), 1, 'Hidden duplicate does not create another shield');
  await click('Open Palladin suggestions'); await click(`Fill and log in: ${username}`);
  await wait(() => page.evaluate(() => globalThis.submissions === 1), 'formless native button submit');
  console.log('PASS: open-root formless login excludes hidden duplicate, keeps aligned shield and clicks one native action');
  await page.goto('https://linkedin.example.test/login');
  await page.locator('[id="«r3»"]').scrollIntoViewIfNeeded();
  await wait(async () => await page.locator('[id="«r4»"]').inputValue() === password, 'observed LinkedIn formless fill');
  await aligned('[id="«r3»"]');
  assert.equal(await page.locator('palladin-autofill').count(), 1);
  assert.equal(await page.locator('[id="«r0»"]').inputValue(), '');
  assert.equal(await page.locator('[id="«r1»"]').inputValue(), '');
  console.log('PASS: observed LinkedIn variants fill only visible controls and mount one aligned shield');
  // Synthetic page-framework mutations, not claimed as observed LinkedIn behavior.
  const preservedHost = await page.locator('palladin-autofill').elementHandle();
  await page.locator('palladin-autofill').evaluate(host => host.remove());
  await wait(() => preservedHost.evaluate(host => host.isConnected), 'removed shield host restored');
  assert.equal(await page.locator('palladin-autofill').count(), 1);
  await aligned('[id="«r3»"]');
  await page.locator('[id="«r3»"]').evaluate(input => { input.parentElement.style.transition = 'transform 300ms linear'; });
  await page.waitForTimeout(40);
  await page.locator('[id="«r3»"]').evaluate(input => { input.parentElement.style.transform = 'translateY(100px)'; });
  await page.waitForTimeout(400);
  await aligned('[id="«r3»"]');
  console.log('PASS: synthetic host removal and completed transform transition recover one aligned shield');
  // Synthetic upgrade of a pre-existing host: no light-DOM mutation, resize,
  // focus or unrelated interaction may be needed to discover its open root.
  await page.route('https://proton.example.test/late-shadow', route => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<style>body{margin:60px}</style><late-login-fields id="component"></late-login-fields>',
  }));
  await page.goto('https://proton.example.test/late-shadow');
  await page.waitForTimeout(400);
  await page.evaluate(markup => {
    customElements.define('late-login-fields', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<style>input{display:block;width:400px;height:40px;margin:12px}</style>' + markup;
      }
    });
  }, proton);
  await page.waitForTimeout(750);
  assert.equal(await page.locator('palladin-autofill').count(), 1, 'late attached open root must receive one shield');
  await wait(async () => await page.locator('late-login-fields #password').inputValue() === password, 'late shadow exact-host fill');
  await aligned('#username');
  console.log('PASS: synthetic late custom-element upgrade discovers the observed Proton controls without another page mutation');
  assert.deepEqual(api.errors, []);
} finally {
  popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true });
}
