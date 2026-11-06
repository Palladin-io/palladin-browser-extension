import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createCaptureApi, allowCaptureApi } from '../../browser/capture-api.mjs';
import { openNativePopup } from '../../browser/native-popup.mjs';
import { cacheBustContentLoaders } from '../../../scripts/cache-bust-content-loaders.mjs';
import { validateBuiltManifest } from '../../../scripts/validate-built-manifest.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const site = fileURLToPath(new URL('./site/', import.meta.url));
const smoke = process.argv.includes('--smoke');
const hosted = process.argv.find(arg => arg.startsWith('--site='))?.slice(7);
if (hosted && (!smoke || new URL(hosted).protocol !== 'https:')) throw Error('--site requires --smoke and an HTTPS URL');
const origin = hosted ? new URL(hosted).origin : 'https://capture.example.test';
const files = new Map([['/', ['index.html','text/html']], ['/lab.js',['lab.js','text/javascript']], ['/lab.css',['lab.css','text/css']], ['/favicon.svg',['favicon.svg','image/svg+xml']], ['/totp.png',['totp.png','image/png']]]);
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-capture-lab-'));
const api = await createCaptureApi();
let context, popup;
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    popup?.close();
    await context?.close();
    await api.close();
    await rm(profile, { recursive: true, force: true });
  })();
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
try {
  const extension = path.join(profile, 'dist/chromium');
  console.log('Building disposable extension and synthetic Vault…');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    cwd: root, env: { ...process.env, PALLADIN_TARGET:'chromium', PALLADIN_CHANNEL:'production', VITE_API_URL:api.url, VITE_POSTHOG_KEY:'' }, maxBuffer:4*1024*1024,
  });
  cacheBustContentLoaders(profile, 'chromium');
  validateBuiltManifest(profile, 'chromium');
  await allowCaptureApi(extension, api.url);
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:smoke, locale:'en-US', viewport:{width:1360,height:1000},
    args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'],
  });
  // Abort every external HTTP(S) request except the disposable API. In particular,
  // provider names below are local fixtures, never live OAuth endpoints.
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.origin === api.url || (hosted && url.origin === origin)) return route.continue();
    if (url.origin === origin || url.origin === 'https://payment.example.test') {
      if (url.pathname === '/callback') return route.fulfill({ contentType:'text/html', body:'<!doctype html><title>Capture lab</title><h1>Signed in to synthetic service</h1><p>No real authorization occurred.</p><a href="/?scenario=oauth">Return to lab</a>' });
      const file = files.get(url.pathname);
      if (!file) return route.abort();
      let body = await readFile(path.join(site,file[0]));
      if (file[0] === 'index.html') body = Buffer.from(body.toString().replace('<html lang="en">','<html lang="en" data-isolated-lab="true">'));
      return route.fulfill({contentType:file[1],body});
    }
    const recognized = (url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth') || (url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize');
    if (recognized) return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Synthetic provider</title><h1>Synthetic authorization</h1><p>This page is intercepted locally. No real account, token or provider connection.</p><p><a href="${origin}/callback?code=synthetic-lab-code&state=synthetic-lab-state">Allow</a></p><p><a href="${origin}/callback?error=access_denied&state=synthetic-lab-state">Cancel</a></p>`});
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker',{timeout:20000});
  const extensionId = new URL(worker.url()).host;
  const onboarding = context.pages().find(p=>p.url().includes('/onboarding/')) ?? await context.waitForEvent('page',{predicate:p=>p.url().includes('/onboarding/')});
  await onboarding.close();
  popup = await openNativePopup(worker, profile, extensionId);
  await popup.click('Continue to Palladin');
  await popup.waitButton('Sign in');
  assert.equal((await popup.configureConnection({name:'Capture lab (disposable)',apiUrl:api.url,webUrl:api.url,allowHttp:true,sharedUnlockEnabled:false})).ok,true);
  await popup.fill('input[type="email"]',api.email);
  await popup.fill('input[type="password"]',api.password);
  await popup.click('Sign in');
  await popup.waitText('No entries yet.');
  await popup.dismiss(); popup = null;
  const page = await context.newPage();
  if (smoke) {
    const checkNotice = async (name, heading, saveLogin = false) => {
      await page.locator('palladin-capture').waitFor({state:'attached',timeout:15000});
      assert.equal(await page.locator('palladin-capture').evaluate(el=>el.shadowRoot),null);
      popup = await openNativePopup(worker,profile,extensionId);
      try { await popup.waitText(heading); } catch (error) { await popup.screenshot('/tmp/capture-lab-native-failure.png'); throw error; }
      if (name === 'password update') {
        await popup.click('Review');
        await popup.waitText('Automatically update passwords for this account');
      }
      if (saveLogin) {
        await popup.click('Review');
        await popup.click('Save entry', 'button', {completedText:'Login saved'});
        await popup.waitText('Login saved');
      }
      await popup.dismiss(); popup = null;
      console.log(`PASS: ${name} reaches real native capture`);
    };
    await page.goto(`${origin}/?scenario=login`);
    await page.getByLabel('Username',{exact:true}).fill('capture-user@example.test');
    await page.getByLabel('Password',{exact:true}).fill('Lab-first-password-42!');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await checkNotice('login','Save your login?',true);
    assert.equal(api.writes.length,1);
    await page.goto(`${origin}/?scenario=update`);
    await page.getByLabel('Username',{exact:true}).fill('capture-user@example.test');
    await page.getByLabel('Current password',{exact:true}).fill('Lab-first-password-42!');
    await page.getByLabel('New password',{exact:true}).fill('Lab-updated-password-43!');
    await page.getByLabel('Confirm new password',{exact:true}).fill('Lab-updated-password-43!');
    await page.getByRole('button',{name:'Change password',exact:true}).click();
    await checkNotice('password update','Save your login?');
    await page.goto(`${origin}/?scenario=card`);
    await page.getByLabel('Cardholder name').fill('Capture User');
    await page.getByLabel('Expiry month').fill('12');
    await page.getByLabel('Expiry year').fill('2031');
    await page.getByLabel('CVC / CVV').fill('123');
    await page.getByLabel('Card number').fill('4242424242424242');
    await page.getByRole('heading',{name:'Payment details',exact:true}).click();
    await checkNotice('card','Save payment card');
    await page.goto(`${origin}/?scenario=key`);
    await page.getByRole('button',{name:'Generate API key'}).click();
    await checkNotice('API key','Save API key');
    await page.goto(`${origin}/?scenario=totp`);
    await page.getByRole('button',{name:'Reveal setup link'}).click();
    await checkNotice('TOTP link','Save authenticator');
    await page.goto(`${origin}/?scenario=totp`);
    await page.getByRole('button',{name:'Reveal QR code'}).click();
    await checkNotice('TOTP QR','Save authenticator');
    if (!hosted) {
    await page.goto(`${origin}/?scenario=oauth`);
    await page.getByRole('button',{name:'Continue with Google'}).click();
    await page.getByRole('link',{name:'Allow',exact:true}).click();
    await checkNotice('Google sign-in','Remember');
    await page.goto(`${origin}/?scenario=oauth`);
    await page.getByRole('button',{name:'Continue with GitHub'}).click();
    await page.getByRole('link',{name:'Cancel',exact:true}).click();
    await page.waitForTimeout(1800);
    assert.equal(await page.locator('palladin-capture').count(),0);
    }
    await page.goto(`${origin}/?scenario=frame`);
    const payment = page.frameLocator('iframe');
    await payment.getByLabel('Cardholder name').fill('Capture User');
    await payment.getByLabel('Expiry month').fill('12');
    await payment.getByLabel('Expiry year').fill('2031');
    await payment.getByLabel('CVC / CVV').fill('123');
    await payment.getByLabel('Card number').fill('5555555555554444');
    await payment.getByRole('heading',{name:'Payment details',exact:true}).click();
    await checkNotice('embedded card','Save payment card');
    await page.goto(`${origin}/?scenario=generator`);
    await page.getByLabel('New password',{exact:true}).click();
    const cdp = await context.newCDPSession(page);
    const clickInline = async name => {
      let button;
      const deadline = Date.now()+10000;
      while (!button && Date.now()<deadline) {
        button = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(n=>!n.ignored&&n.role?.value==='button'&&n.name?.value===name);
        if (!button) await page.waitForTimeout(100);
      }
      assert(button,`Inline button: ${name}`);
      const {model} = await cdp.send('DOM.getBoxModel',{backendNodeId:button.backendDOMNodeId});
      await page.mouse.click((model.content[0]+model.content[4])/2,(model.content[1]+model.content[5])/2);
    };
    await clickInline('Options');
    await page.waitForTimeout(250);
    await clickInline('Length +');
    await clickInline('Use strong password');
    await page.waitForFunction(()=>document.querySelector('[name=password]').value.length>0);
    assert.equal(await page.locator('[name=password]').inputValue(),await page.locator('[name=confirm]').inputValue());
    assert.equal(await page.locator('form').count(),1);
    assert.equal(api.writes.length,1,'Only the explicitly saved login is written');
    assert.deepEqual(api.errors,[]);
    console.log('PASS: inline options fill matching passwords without submitting or saving; no unexpected Vault writes');
  } else {
    await page.goto(origin);
    console.log(`Capture lab ready: ${origin}\nUse only this disposable browser. Close it or press Ctrl+C to discard the test Vault.`);
    await new Promise(resolve=>context.once('close',resolve));
  }
} finally { await stop(); }
