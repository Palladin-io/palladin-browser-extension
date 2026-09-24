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
const apple = await readFile('tests/fixtures/forms/apple-idmsa-signin-2026-09-16/page.html', 'utf8');
try {
  const vault = api.vaults[0];
  for (const host of ['proton.example.test', 'jetbrains.example.test', 'linkedin.example.test', 'aws.example.test', 'idmsa.apple.com']) {
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
  vault.detail.memberSequence = '6'; vault.detail.entryCount = 5;
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  await context.route('https://**/*', route => {
    const url = new URL(route.request().url());
    const host = url.hostname;
    if (host === 'account.apple.com' && url.pathname === '/sign-in') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        '<!doctype html><title>Apple sign-in fixture</title><iframe title="Apple sign-in" style="width:640px;height:360px" src="https://idmsa.apple.com/appleauth/auth/authorize/signin"></iframe>' });
    }
    if (host === 'idmsa.apple.com' && url.pathname === '/appleauth/auth/authorize/signin') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        `<!doctype html><style>body{margin:40px}#sign_in_form{width:420px}input{display:block;width:380px;height:40px;margin:12px 0}.hide-password #password_text_field{display:none}</style>${apple}<script>
        document.querySelector('#sign-in').addEventListener('click', () => document.querySelector('#sign_in_form').classList.remove('hide-password'));
        </script>` });
    }
    if (host === 'other.example.test' && url.pathname === '/apple-frame') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        '<!doctype html><iframe title="Foreign Apple frame" style="width:640px;height:360px" src="https://idmsa.apple.com/appleauth/auth/authorize/signin"></iframe>' });
    }
    if (!host.endsWith('.example.test')) return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<style>body{margin:60px}form{width:450px}input:not([type=checkbox]){display:block;width:400px;height:40px;margin:12px 0}button{min-height:35px}</style>${host.startsWith('proton') ? proton : host.startsWith('linkedin') ? linkedin : jetbrains}<script>globalThis.submissions=0;document.querySelector('form')?.addEventListener('submit',event=>{if(event.defaultPrevented)return;event.preventDefault();globalThis.submissions++})</script>` });
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
  await page.goto('https://account.apple.com/sign-in');
  const appleFrame = page.frameLocator('iframe');
  await wait(async () => await appleFrame.locator('#account_name_text_field').inputValue() === username,
    'Apple cross-origin child receives exact-host identifier fill');
  assert.equal(await appleFrame.locator('#password_text_field').inputValue(), '');
  assert.equal(await appleFrame.locator('palladin-autofill').count(), 1);
  await appleFrame.locator('#sign-in').click();
  await wait(async () => {
    if (!await appleFrame.locator('#password_text_field').isVisible()
      || await appleFrame.locator('palladin-autofill').count() !== 1) return false;
    const field = await appleFrame.locator('#password_text_field').boundingBox();
    const shield = await appleFrame.locator('palladin-autofill').boundingBox();
    return Math.abs(field.y + field.height / 2 - shield.y - shield.height / 2) < 1;
  },
  'Apple password step retains one shield');
  assert.equal(await appleFrame.locator('#password_text_field').inputValue(), '');
  const frameTree = await cdp.send('Page.getFrameTree');
  const appleFrameId = frameTree.frameTree.childFrames?.[0]?.frame.id;
  const clickApple = async name => {
    let node;
    await wait(async () => {
      node = (await cdp.send('Accessibility.getFullAXTree', { frameId: appleFrameId })).nodes.find(candidate =>
        !candidate.ignored && candidate.role?.value === 'button' && candidate.name?.value === name);
      return Boolean(node);
    }, `Apple child action: ${name}`);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
    const box = await page.locator('iframe').boundingBox();
    await page.mouse.click(box.x + (model.content[0] + model.content[4]) / 2,
      box.y + (model.content[1] + model.content[5]) / 2);
  };
  await clickApple('Open Palladin suggestions');
  await clickApple(`Fill and log in: ${username}`);
  await wait(async () => await appleFrame.locator('#password_text_field').inputValue() === password,
    'Apple child receives explicit password fill');
  const agentOutcome = await worker.evaluate(async () => {
    for (const tab of await chrome.tabs.query({})) {
      try {
        const current = await chrome.tabs.sendMessage(tab.id, { channel: 'palladin.tab/current-url' }, { frameId: 0 });
        if (current.url !== 'https://account.apple.com/sign-in') continue;
        const probe = await chrome.tabs.sendMessage(tab.id, {
          channel: 'palladin.agent-live/probe', documentId: current.documentId, targetUrl: current.url,
        }, { frameId: 0 });
        return probe.outcome;
      } catch { /* Other extension or browser pages have no top-frame content handler. */ }
    }
    return 'missing-top-frame';
  });
  assert.equal(agentOutcome, 'challenge', 'Agent adapter must not fill the Apple child from the top frame');
  await page.goto('https://other.example.test/apple-frame');
  await wait(async () => await page.frameLocator('iframe').locator('#account_name_text_field').count() === 1,
    'foreign top loaded the Apple specimen');
  assert.equal(await page.frameLocator('iframe').locator('palladin-autofill').count(), 0);
  console.log('PASS: installed Chromium extension mounts and fills the observed Apple child frame; foreign top denied');
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
      document.querySelector('form').addEventListener('submit',event=>{globalThis.submitEvents++;queueMicrotask(()=>{globalThis.blockedDefault=event.defaultPrevented})});
      ${unsafe ? '' : "document.querySelector('#next_button').addEventListener('click',event=>{event.preventDefault();globalThis.nextClicks++;document.querySelector('#resolving_input').form.innerHTML='<input id=next-password type=password autocomplete=current-password><button type=submit>Sign in</button>'})"}
      </script>` });
  });
  // Value-free transport observation in this synthetic harness. Runtime grant
  // authorization is substituted; the actual worker issues the automatic epoch.
  await worker.evaluate(() => {
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (tabId, message, ...rest) => {
      if (message?.channel === 'palladin.fill/request' && message.intent === 'automatic') {
        globalThis.syntheticAutomaticBinding = { tabId, documentId: message.documentId, sessionId: message.automaticFillSessionId };
      }
      return send(tabId, message, ...rest);
    };
  });
  for (const collision of ['replace', 'different-session', 'page-edited']) {
    await page.goto(`https://aws.example.test/collision-${collision}`);
    await wait(async () => await page.locator('#resolving_input').inputValue() === username, 'actual worker automatic provenance');
    if (collision === 'page-edited') await page.locator('#resolving_input').fill('synthetic-human@example.test');
    const outcome = await worker.evaluate(async collision => {
      const { tabId, documentId, sessionId } = globalThis.syntheticAutomaticBinding;
      if (!sessionId) throw new Error('Expected a worker-issued automatic epoch');
      const targetUrl = `https://aws.example.test/collision-${collision}`;
      const probe = await chrome.tabs.sendMessage(tabId, { channel: 'palladin.agent-live/probe', documentId, targetUrl }, { frameId: 0 });
      if (probe.outcome !== 'ready') throw new Error('Synthetic initial live plan unavailable');
      const ready = await chrome.tabs.sendMessage(tabId, { channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
        expectedDomain: 'aws.example.test', form: probe.form, expiresAt: Date.now() + 10_000,
        automaticFillSessionId: collision === 'different-session' ? (sessionId === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32)) : sessionId,
        values: [{ entryFieldId: 'credential.username', value: 'synthetic-agent@example.test' }] }, { frameId: 0 });
      if (!ready.ok) return { filled: false };
      const commit = await chrome.tabs.sendMessage(tabId, { channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'aws.example.test',
        submitReady: ready.submitReady, expiresAt: Date.now() + 1_000 }, { frameId: 0 });
      return { filled: true, committed: commit.ok };
    }, collision);
    assert.equal(outcome.filled, collision === 'replace');
    if (collision === 'replace') {
      assert.equal(outcome.committed, true);
      await wait(() => page.evaluate(() => globalThis.nextClicks === 1), 'authorized agent replacement commits once');
    } else {
      assert.equal(await page.evaluate(() => globalThis.nextClicks), 0);
      assert.equal(await page.locator('#resolving_input').inputValue(), collision === 'page-edited' ? 'synthetic-human@example.test' : username);
    }
  }
  console.log('PASS: actual automatic fill followed by synthetic authorized agent replacement; changed session and human edit rejected');
  awsRequests.length = 0;
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
    const controls = '<input id="shadow-username" autocomplete="username"><input id="shadow-password" type="password" autocomplete="current-password"><button type="button">Fortsett</button>';
    root.innerHTML = '<style>input{display:block;width:400px;height:40px;margin:12px}section{width:450px}</style><section>' + controls + '</section><section hidden>' + controls + '</section>';
    root.querySelector('button').addEventListener('click', () => { globalThis.submissions++; });
    document.body.append(component);
  });
  await wait(async () => await page.locator('#component input[type="password"]').first().inputValue() === password, 'open-root formless fill');
  await aligned('#shadow-username');
  assert.equal(await page.locator('palladin-autofill').count(), 1, 'Hidden duplicate does not create another shield');
  await click('Open Palladin suggestions'); await click(`Fill and log in: ${username}`);
  await wait(() => page.evaluate(() => globalThis.submissions === 1), 'formless native button submit');
  await page.evaluate(() => { const button = document.querySelector('#component').shadowRoot.querySelector('button'); button.textContent = ''; button.setAttribute('aria-label', 'Continue'); button.style.width = '40px'; });
  await click('Open Palladin suggestions'); await click(`Fill and log in: ${username}`);
  await wait(() => page.evaluate(() => globalThis.submissions === 2), 'formless icon action aria-label');
  console.log('PASS: open-root formless login excludes hidden duplicate and clicks localized and aria-labelled native actions');
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
