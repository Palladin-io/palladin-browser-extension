import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createCaptureApi } from './capture-api.mjs';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';
import { openNativePopup } from './native-popup.mjs';
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs';

const api = await createCaptureApi();
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-generator-'));
let context;
let popup;
async function waitForReveal(value) {
  const deadline = Date.now() + 10000;
  while (!(await popup.hasText(value)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(await popup.hasText(value), 'History reveals the original generated value');
}
try {
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' },
    maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium');
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  context = await launch();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const onboarding = context.pages().find(page => page.url().includes('/onboarding/'));
  if (onboarding) await onboarding.close();
  popup = await openNativePopup(worker, profile, extensionId);
  await popup.click('Continue to Palladin');
  await popup.fill('input[type=email]', api.email);
  await popup.fill('input[type=password]', api.password);
  await popup.click('Sign in');
  await popup.waitText('No entries yet.');
  await context.route('https://register.example.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <style>body{margin:80px;font:16px system-ui}input{display:block;padding:12px;margin:16px;width:320px}button{margin-top:180px}</style>
    <form><label>Email<input autocomplete="username" name="username"></label>
    <label>New password<input type="password" autocomplete="new-password" name="password"></label>
    <label>Confirm password<input type="password" autocomplete="new-password" name="confirm"></label>
    <button>Register</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('form').outerHTML='<p role="status">Account created</p>'}</script>` }));
  const page = await context.newPage();
  await page.goto('https://register.example.test/signup');
  await page.getByLabel('Email', { exact: true }).fill('synthetic-user');
  await page.getByLabel('New password', { exact: true }).click();
  const cdp = await context.newCDPSession(page);
  const find = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.find(node =>
    !node.ignored && node.role?.value === 'button' && node.name?.value === 'Use strong password');
  const deadline = Date.now() + 10000;
  let button;
  while (!(button = await find()) && Date.now() < deadline) await page.waitForTimeout(100);
  assert(button, 'Inline generation action is accessible');
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: button.backendDOMNodeId });
  await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
  await page.waitForFunction(() => document.querySelector('[name=password]').value.length === 20).catch(async error => {
    const nodes = (await cdp.send('Accessibility.getFullAXTree')).nodes;
    console.log('Generation diagnostics', {
      errorVisible: nodes.some(node => node.name?.value?.includes('Could not')),
      actionDisabled: nodes.find(node => node.role?.value === 'button' && node.name?.value === 'Use strong password')?.properties?.find(property => property.name === 'disabled')?.value?.value,
      historyCount: await worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('palladin.generator-history.v1:')).length),
      fields: await page.locator('input').evaluateAll(inputs => inputs.map(input => ({name:input.name,length:input.value.length}))),
      host: await page.locator('palladin-autofill').evaluateAll(hosts => hosts.map(host => ({width:host.getBoundingClientRect().width,height:host.getBoundingClientRect().height,pointerEvents:getComputedStyle(host).pointerEvents}))),
    });
    throw error;
  });
  const generated = await page.locator('[name=password]').inputValue();
  assert.equal(await page.locator('[name=confirm]').inputValue(), generated);
  assert.equal(api.writes.length, 0, 'Generation must not create a Vault entry');
  const stored = await worker.evaluate(() => chrome.storage.local.get(null));
  const historyKeys = Object.keys(stored).filter(key => key.startsWith('palladin.generator-history.v1:'));
  assert.equal(historyKeys.length, 1);
  assert(!JSON.stringify(stored).includes(generated), 'Persistent storage must contain no generated plaintext');
  assert(!JSON.stringify(stored[historyKeys[0]]).includes('register.example.test'), 'Origin metadata must be encrypted');
  console.log('PASS: trusted inline action fills both fields only after encrypted recovery persistence');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Account created' }).waitFor();
  popup.close();
  popup = await openNativePopup(worker, profile, extensionId);
  await popup.click('Password history', 'tab');
  await popup.waitText('register.example.test');
  await popup.click('Reveal');
  await waitForReveal(generated);
  popup.close();
  await context.close();
  context = await launch();
  const restartedWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  popup = await openNativePopup(restartedWorker, profile, extensionId);
  await popup.fill('input[type=password]', api.password);
  await popup.click('Unlock');
  await popup.click('Password history', 'tab');
  await popup.click('Reveal');
  await waitForReveal(generated);
  console.log('PASS: history survives actual browser restart and requires fresh unlock');
} finally {
  popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true });
}
