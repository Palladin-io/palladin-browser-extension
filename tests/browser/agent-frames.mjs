import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';
const specimen = await readFile('tests/fixtures/forms/apple-id-2026-10-02/page.html', 'utf8');
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-frames-'));
let context;
try {
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: 'https://api.example.test', VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium');
  // Test-only worker entry: real routing and content scripts, synthetic native
  // authorization. This harness is never included in distributable artifacts.
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@shared': path.resolve('src/shared') } },
    build: { outDir: extension, emptyOutDir: false, lib: { entry: path.resolve('tests/browser/agent-frame-harness.ts'), formats: ['es'], fileName: () => 'frame-harness.js' } } });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const original = manifest.background.service_worker;
  await writeFile(path.join(extension, 'test-worker.js'), `import './${original}'; import * as harness from './frame-harness.js'; globalThis.frameHarness = harness;`);
  manifest.background.service_worker = 'test-worker.js';
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 1200 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route(/^https?:/, route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'appstoreconnect.apple.com') return route.fulfill({ contentType: 'text/html', body: '<iframe id="login" style="width:700px;height:700px" src="https://idmsa.apple.com/appleauth/auth/signin"></iframe>' });
    if (url.hostname === 'idmsa.apple.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: specimen + `<script>
      // Synthetic input/step behavior, not captured Apple JavaScript.
      const user=document.querySelector('#account_name_text_field'), button=document.querySelector('#sign-in');
      user.addEventListener('input',()=>button.disabled=!user.value);
      globalThis.clicks=0; button.addEventListener('click',()=>{ globalThis.clicks++; });
      </script>` });
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const send = raw => worker.evaluate(raw => globalThis.frameHarness.send(raw), raw);
  let serial = 0;
  async function prepare() {
    await worker.evaluate(() => globalThis.frameHarness.reset());
    await page.locator('#login').waitFor();
    const tabId = await worker.evaluate(async () => {
      for (const tab of await chrome.tabs.query({})) {
        try { const current=await chrome.tabs.sendMessage(tab.id,{channel:'palladin.tab/current-url'},{frameId:0});
          if(current.url.startsWith('https://appstoreconnect.apple.com/')) return tab.id;
        } catch { /* Non-page extension tabs. */ }
      }
    });
    let result;
    for (let i=0;i<50;i++) {
      try { result=await send({ protocol:'palladin.inject-provider.v1',type:'prepare',nonce:'a'.repeat(64),targetTabId:tabId,targetUrl:page.url(),liveDetection:true }); if(result.outcome==='ready') break; } catch {}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return result;
  }
  function injection(plan, expectedDomain='idmsa.apple.com') { return { protocol:'palladin.inject-provider.v1',type:'inject',transactionId:`tx-${++serial}`,grantId:'grant',entryId:'entry',
    expectedDomain,form:plan,continueLive:true,expiresAt:Date.now()+10_000,values:[{entryFieldId:'credential.username',value:'synthetic@example.test'}] }; }
  for(const scenario of ['success','stays-disabled','enabled-pointer-blocked','hide-before-submit','hidden','duplicate','navigate-child','replace-child','navigate-top','wrong-entry-host']) {
    await page.goto('https://appstoreconnect.apple.com/login');
    const prepared=await prepare(); assert.equal(prepared?.outcome,'ready',`prepare ${scenario}`);
    assert.equal(prepared.currentUrl,'https://idmsa.apple.com/appleauth/auth/signin');
    assert.deepEqual(prepared.liveForm.steps[0].fields.map(f=>f.entryFieldId),['credential.username']);
    const child=page.frame({url:'https://idmsa.apple.com/appleauth/auth/signin'});
    if(scenario==='hidden') await page.locator('#login').evaluate(el=>el.style.display='none');
    if(scenario==='duplicate') await page.locator('#login').evaluate(el=>el.after(el.cloneNode(true)));
    if(scenario==='navigate-child') await child.goto('https://idmsa.apple.com/other');
    if(scenario==='replace-child') await page.locator('#login').evaluate(el=>el.replaceWith(el.cloneNode(true)));
    if(scenario==='navigate-top') await page.goto('https://appstoreconnect.apple.com/other');
    if (scenario === 'stays-disabled') await child.locator('#sign-in').evaluate(el => { document.querySelector('#account_name_text_field').addEventListener('input', () => { el.disabled = true; }); });
    if (scenario === 'enabled-pointer-blocked') await child.locator('#sign-in').evaluate(el => { el.style.pointerEvents = 'none'; });
    const request=injection(prepared.liveForm,scenario==='wrong-entry-host'?'appstoreconnect.apple.com':'idmsa.apple.com');
    const filled=await send(request);
    if(scenario==='success' || scenario==='hide-before-submit') {
      assert.equal(filled.outcome,'submit-ready');
      assert.equal(await child.locator('#account_name_text_field').inputValue(),'synthetic@example.test');
      assert.equal(await child.locator('#password_text_field').inputValue(),'');
      assert.equal(await child.evaluate(()=>globalThis.clicks),0);
      if(scenario==='hide-before-submit') await page.locator('#login').evaluate(el=>el.style.display='none');
      // End at a challenge after one separately authorized click; no retries.
      await child.evaluate(()=>document.querySelector('#sign-in').addEventListener('click',()=>{
        if(globalThis.clicks===1) {
          document.querySelector('#sign_in_form').classList.remove('hide-password');
          document.querySelector('.password .form-cell-wrapper').style.height='40px';
          document.querySelector('#account_name_text_field').readOnly=true;
          const button=document.querySelector('#sign-in'); button.disabled=true; button.textContent='Zaloguj się';
          document.querySelector('#password_text_field').addEventListener('input',()=>button.disabled=false);
        } else document.body.innerHTML='<div data-sitekey="synthetic">Challenge</div>';
      }));
      const committed=await send({protocol:'palladin.inject-provider.v1',type:'submit',transactionId:`tx-${++serial}`,preparedTransactionId:request.transactionId,
        grantId:'grant',entryId:'entry',expectedDomain:'idmsa.apple.com',submitReady:filled.submitReady,expiresAt:Date.now()+1000});
      if(scenario==='success') {
        assert.equal(committed.outcome,'injected'); assert.equal(committed.continuation.outcome,'ready');
        assert.deepEqual(committed.continuation.liveForm.steps[0].fields.map(field=>field.entryFieldId),['credential.username','credential.password']);
        assert.equal(await child.evaluate(()=>globalThis.clicks),1);
        const passwordRequest=injection(committed.continuation.liveForm);
        passwordRequest.values.push({entryFieldId:'credential.password',value:'Synthetic-only-password!42'});
        const passwordReady=await send(passwordRequest); assert.equal(passwordReady.outcome,'submit-ready');
        assert.equal(await child.locator('#password_text_field').inputValue(),'Synthetic-only-password!42');
        assert.equal(await child.evaluate(()=>globalThis.clicks),1);
        const done=await send({protocol:'palladin.inject-provider.v1',type:'submit',transactionId:`tx-${++serial}`,preparedTransactionId:passwordRequest.transactionId,
          grantId:'grant',entryId:'entry',expectedDomain:'idmsa.apple.com',submitReady:passwordReady.submitReady,expiresAt:Date.now()+1000});
        assert.equal(done.outcome,'injected'); assert.equal(done.continuation.outcome,'challenge');
        assert.equal(await child.evaluate(()=>globalThis.clicks),2);
      } else {
        assert.equal(committed.outcome,'rejected');
        assert.equal(await child.evaluate(()=>globalThis.clicks),0);
        await child.waitForFunction(()=>document.querySelector('#account_name_text_field').value==='');
      }
    } else { assert.notEqual(filled.outcome,'submit-ready');
      if (scenario === 'stays-disabled' || scenario === 'enabled-pointer-blocked') assert.equal(await child.evaluate(()=>globalThis.clicks),0);
      for(const frame of page.frames().slice(1)) assert.equal(await frame.locator('#account_name_text_field').inputValue().catch(()=>''),'');
    }
    console.log(`PASS framed login: ${scenario}`);
  }
} finally { await context?.close(); await rm(profile,{recursive:true,force:true}); }
