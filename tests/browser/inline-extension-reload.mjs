import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs'
import { openNativePopup } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

// Faithful CaptureLab specimen by default; --live uses the public Netlify DOM.
// Disposable Chromium and synthetic account/API; no merchant sign-in assertion.
const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const live = process.argv.includes('--live');
const specimen = await readFile('tests/fixtures/forms/capturelab-login/page.html','utf8');
const api = await createCaptureApi();
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-extension-reload-'));
let context, popup;

try {
  const extension = path.join(profile, 'dist/chromium')
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024 })
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium'); await allowCaptureApi(extension, api.url)
  const manifestPath=path.join(extension,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  // Test-only host permission isolates reload from activeTab grant lifetime.
  manifest.host_permissions.push('https://palladin-capture-lab.netlify.app/*');
  await writeFile(manifestPath,JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).host
  await context.route('https://**/*', route => new URL(route.request().url()).hostname === 'palladin-capture-lab.netlify.app' ? (live ? route.continue() : route.fulfill({contentType:'text/html',body:specimen})) : route.abort())
  const onboarding = context.pages().find(p => p.url().includes('/onboarding/')) ?? await context.waitForEvent('page', { predicate: p => p.url().includes('/onboarding/') })
  await onboarding.close(); popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in')
  assert.equal((await popup.configureConnection({ name: 'Synthetic API', apiUrl: api.url, webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true)
  await popup.fill('input[type="email"]', api.email); await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in'); await popup.waitText('No entries yet.')

  await popup.dismiss(); popup=null;
  const page=await context.newPage();
  await page.goto('https://palladin-capture-lab.netlify.app/?scenario=login');
  await page.getByLabel('Username',{exact:true}).click();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('palladin-autofill').count(),1,'shield before reload');
  const cdp = await context.newCDPSession(page);
  const statusText = async () => {
    const {root} = await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
    const texts=[];
    const walk = node => { if(node.nodeType===3) texts.push(node.nodeValue); for(const child of [...(node.children??[]),...(node.shadowRoots??[])]) walk(child); };
    const surfaces = node => {
      if (node.localName === 'palladin-autofill') { for (const shadow of node.shadowRoots ?? []) walk(shadow); return; }
      for (const child of node.children ?? []) surfaces(child);
    };
    surfaces(root); return texts.join(' ');
  };
  const clickShield = async () => {
    const bounds=await page.locator('palladin-autofill').boundingBox();
    assert(bounds,'shield exists');
    await page.mouse.click(bounds.x+13,bounds.y+13);
    for (let attempt=0;attempt<50;attempt++) {
      const text=await statusText();
      if (text.includes('No Palladin login matches this website.') || text.includes('temporarily unavailable') || text.includes('Palladin is locked.')) return text;
      await page.waitForTimeout(100);
    }
    await page.screenshot({path:'/tmp/palladin-reload-status-timeout.png'});
    throw new Error('No settled inline suggestion status');
  };
  const before = await clickShield();
  assert(before.includes('No Palladin login matches this website.'),'working empty suggestion list before reload');
  console.log('Before reload: working suggestion list');
  await page.getByRole('heading',{name:'Sign in',exact:true}).click();
  const management = await context.newPage();
  await management.goto('chrome://extensions');
  await management.evaluate(() => new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},resolve)));
  await page.getByLabel('Username',{exact:true}).fill('reload-test@example.test');
  let previousWorker = worker;
  for (let reload = 1; reload <= 2; reload++) {
  const restart = context.waitForEvent('serviceworker',{predicate:candidate=>candidate!==previousWorker});
  await management.evaluate(id => new Promise((resolve,reject) => chrome.developerPrivate.reload(id,{},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve())),extensionId);
  const restarted=await restart; previousWorker=restarted;
  popup=await openNativePopup(restarted,profile,extensionId);
  await popup.waitButton('Unlock');
  await popup.fill('input[type="password"]',api.password);
  await popup.click('Unlock'); await popup.waitText('No entries yet.');
  await popup.dismiss(); popup=null;
  await page.bringToFront();
  assert.equal(await page.getByLabel('Username',{exact:true}).inputValue(),'reload-test@example.test','reload does not replace existing form input');
  const after = await clickShield();
  assert.equal(await page.locator('palladin-autofill').count(),1,'one shield after reload');
  const extensionState = await management.evaluate(id => new Promise(resolve => {
    chrome.developerPrivate.getExtensionsInfo({}, items => resolve(items.filter(x => x.id === id).map(x => ({state:x.state}))));
  }), extensionId);

  assert.equal(extensionState[0]?.state,'ENABLED','reload must finish with extension enabled');
  assert(after.includes('No Palladin login matches this website.'),'extension reload must restore working suggestions without refreshing the existing page');
  assert(!after.includes('temporarily unavailable'),'no stale unavailable surface');
  await page.getByRole('heading',{name:'Sign in',exact:true}).click();
  console.log(`PASS reload ${reload}: unlocked suggestions without page refresh, one shield`);
  }
  await page.reload();
  await page.locator('palladin-autofill').waitFor({state:'visible'});
  const refreshed = await clickShield();
  assert(refreshed.includes('No Palladin login matches this website.'),'page refresh preserves working suggestions');
  assert.equal(await page.locator('palladin-autofill').count(),1,'one shield after page refresh');
  console.log(`PASS ${live ? 'live Netlify' : 'offline specimen'} page refresh`);
  const versions = new Map();
  let stoppedByBrowser = false;
  cdp.on('ServiceWorker.workerVersionUpdated', ({versions: updates}) => {
    for (const version of updates) {
      versions.set(version.versionId, version);
      if (version.scriptURL.startsWith(`chrome-extension://${extensionId}/`) && version.runningStatus === 'stopped') stoppedByBrowser = true;
    }
  });
  await cdp.send('ServiceWorker.enable');
  let version;
  for(let attempt=0;attempt<50 && !version;attempt++) {
    version=[...versions.values()].find(v=>v.scriptURL===previousWorker.url() && v.runningStatus==='running');
    if(!version) await page.waitForTimeout(100);
  }
  assert(version,'running extension worker is exposed by browser');
  await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
  await cdp.send('ServiceWorker.startWorker',{scopeURL:`chrome-extension://${extensionId}/`});
  for(let attempt=0;attempt<50;attempt++) {
    if(stoppedByBrowser && versions.get(version.versionId)?.runningStatus==='running') break;
    await page.waitForTimeout(100);
  }
  assert(stoppedByBrowser && versions.get(version.versionId)?.runningStatus==='running','browser stopped and restarted worker');
  await page.getByRole('heading',{name:'Sign in',exact:true}).click();
  const locked=await clickShield();
  assert(locked.includes('Palladin is locked.'),'ordinary worker restart retains a working shield and loses unlocked key material');
  assert.equal(await page.locator('palladin-autofill').count(),1);
  console.log('PASS ordinary worker restart: one responding shield, session locked');


} finally {popup?.close();await context?.close();await api.close();await rm(profile,{recursive:true,force:true});}
