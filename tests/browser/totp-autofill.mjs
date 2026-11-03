import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import * as crypto from '@palladin/crypto';
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs';
import { openNativePopup } from './native-popup.mjs';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';

// Synthetic encrypted Entries and routed pages; no live account or real service.
const api = await createCaptureApi();
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-totp-'));
let context, popup;
try {
  const vault = api.vaults[0];
  for (const [name, username, seed] of [['A synthetic login', 'first@example.test', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'], ['B synthetic login', 'second@example.test', 'JBSWY3DPEHPK3PXP']]) {
  const entryId = randomUUID();
  const secret = { schema: 'palladin.member-secret.v1', entryType: 'credential', memberLabel: name,
    agentLabel: null, discoverable: false, description: null, icon: null, color: null, agentFieldAccess: { memberLabel: 'never', agentLabel: 'never', description: 'never', icon: 'never', color: 'never', entryType: 'never', 'credential.username': 'never', 'credential.password': 'never', 'credential.url': 'never', 'credential.urlDomain': 'never', 'credential.totp': 'never', notes: 'never' },
    content: { username, password: 'synthetic-password', url: 'https://totp.example.test/login',
      urlDomain: 'totp.example.test', totp: { secret: seed, algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null }, notes: null, customFields: [] } };
  const material = await crypto.sealCanonicalEntry({ organizationId: vault.detail.organizationId, vaultId: vault.detail.id,
    entryId, revision: '1', vaultKeyVersion: 1, vdkVersion: 1, memberKeyGeneration: 1 }, secret, vault.vaultKey, vault.discoveryKey, 1);
  vault.entries.set(entryId, { ...material, id: entryId, organizationId: vault.detail.organizationId, vaultId: vault.detail.id,
    state: 'active', currentRevision: '1', memberIndexRevision: '1', currentKeyVersion: 1,
    agentDiscoveryRevision: null, agentDiscoveryRevisionHighWatermark: '0', deliveryPolicy: 'standard',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  vault.detail.memberSequence = '3'; vault.detail.entryCount = 2;
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024,
  });
  await allowCaptureApi(extension, api.url); cacheBustContentLoaders(profile, 'chromium');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  await context.route('https://totp.example.test/**', route => {
    const pagePath = new URL(route.request().url()).pathname;
    const content = pagePath === '/identifier' ? '<input autocomplete="username"><button>Next</button>'
      : pagePath === '/password' ? '<input type="password"><button>Sign in</button>'
      : pagePath === '/split' ? `<fieldset><legend>Authenticator code</legend>${'<input maxlength="1">'.repeat(6)}</fieldset>`
      : pagePath === '/sms' ? 'Code sent by SMS<input autocomplete="one-time-code">'
      : pagePath === '/filled' ? '<input autocomplete="one-time-code" value="111111">'
      : `${pagePath === '/mfa' ? '' : '<input autocomplete="username"><input type="password">'}<input autocomplete="one-time-code">`;
    return route.fulfill({ contentType: 'text/html', body: `<style>input{display:block;width:400px;height:40px;margin:12px}</style><form>${content}</form>` });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const onboarding = context.pages().find(page => page.url().includes('/onboarding/')) ?? await context.waitForEvent('page', { predicate: page => page.url().includes('/onboarding/') });
  await onboarding.close(); popup = await openNativePopup(worker, profile, extensionId);
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in');
  const configured = await popup.configureConnection({ name: 'Synthetic API', apiUrl: api.url, webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false });
  assert.equal(configured.ok, true); await popup.fill('input[type="email"]', api.email);
  await popup.fill('input[type="password"]', api.password); await popup.click('Sign in'); await popup.waitText('A synthetic login');
  const page = await context.newPage(); await page.goto('https://totp.example.test/login');
  await page.waitForFunction(() => /^\d{6}$/.test(document.querySelector('input[autocomplete="one-time-code"]').value), null, { timeout: 10000 });
  assert.equal(await page.locator('input[autocomplete="username"]').inputValue(), 'first@example.test');
  const second = await context.newPage(); await second.goto('https://totp.example.test/login');
  await second.waitForFunction(() => /^\d{6}$/.test(document.querySelector('input[autocomplete="one-time-code"]').value));
  await second.locator('input[autocomplete="one-time-code"]').fill('');
  await second.locator('input[autocomplete="username"]').fill('second@example.test');
  const cdp = await context.newCDPSession(second);
  const click = async name => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const node = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(item => !item.ignored && item.role?.value === 'button' && item.name?.value?.startsWith(name));
      if (node) { if (name === 'B synthetic login' && process.env.PALLADIN_TOTP_SCREENSHOT) await second.screenshot({ path: process.env.PALLADIN_TOTP_SCREENSHOT });
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
        await second.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2); return; }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error(`Missing chooser control: ${name}`);
  };
  // Two launchers exist; target the OTP shield via its position with a native click.
  const otpRect = await second.locator('input[autocomplete="one-time-code"]').boundingBox();
  await second.mouse.click(otpRect.x + otpRect.width - 21, otpRect.y + 13);
  await click('B synthetic login');
  await second.waitForFunction(() => /^\d{6}$/.test(document.querySelector('input[autocomplete="one-time-code"]').value), null, { timeout: 10000 });
  await page.goto('https://totp.example.test/mfa');
  await page.waitForFunction(() => /^\d{6}$/.test(document.querySelector('input[autocomplete="one-time-code"]').value));
  const firstCode = await crypto.generateTotp({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30 });
  assert.equal(await page.locator('input').evaluate((input, code) => input.value === code, firstCode.code), true, 'first tab kept its account');
  const staged = await context.newPage(); await staged.goto('https://totp.example.test/identifier');
  await staged.waitForFunction(() => document.querySelector('input').value !== '', null, { timeout: 10000 });
  await staged.goto('https://totp.example.test/password');
  await staged.waitForFunction(() => document.querySelector('input').value !== '', null, { timeout: 10000 });
  await staged.goto('https://totp.example.test/mfa');
  await staged.waitForFunction(() => /^\d{6}$/.test(document.querySelector('input').value), null, { timeout: 10000 });
  const split = await context.newPage(); await split.goto('https://totp.example.test/split');
  await split.waitForFunction(() => [...document.querySelectorAll('input')].every(input => /^\d$/.test(input.value)));
  for (const suffix of ['sms', 'filled']) {
    const negative = await context.newPage(); await negative.goto(`https://totp.example.test/${suffix}`);
    await negative.waitForTimeout(600);
    assert.equal(await negative.locator('input').inputValue(), suffix === 'filled' ? '111111' : '');
    await negative.close();
  }
  console.log('PASS: combined, navigation, tab isolation, split and negative OTP fixtures');
} finally { popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true }); }
