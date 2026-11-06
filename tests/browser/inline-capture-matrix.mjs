import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs'
import { openNativePopup, attachNativePopup } from './native-popup.mjs'
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs'
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs'

// Synthetic setup, credential and API. This does not claim real-site acceptance.
const { chromium } = await import(process.env.PALLADIN_PLAYWRIGHT_MODULE ?? 'playwright')
const language=process.env.PALLADIN_VISUAL_LANGUAGE==='pl'?'pl':'en';
const english=JSON.parse(await readFile('src/popup/locales/en.json','utf8'));
const polish=JSON.parse(await readFile('src/popup/locales/pl.json','utf8'));
const label=text=>language==='en'?text:text==='Which Google account did you use?'?polish['signInToast.whichAccount'].replace('{name}','Google'):polish[Object.keys(english).find(key=>english[key]===text)]??text;
const selected = name => !process.env.PALLADIN_VISUAL_SCOPE || process.env.PALLADIN_VISUAL_SCOPE.split(',').includes(name);
const api = await createCaptureApi()
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-inline-matrix-'))
const artifacts = path.resolve('test-results/inline-capture-matrix'); await mkdir(artifacts,{recursive:true});
const pan='4111111111111111', key='sk_test_SyntheticCapture001abcdefghijklmnopqrstuv'; // gitleaks:allow - synthetic capture fixture, never a provider credential
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

  await context.route('https://**/*', route => route.fulfill({contentType:'text/html',body:fixture(new URL(route.request().url()))}));
  const onboarding = context.pages().find(p => p.url().includes('/onboarding/')) ?? await context.waitForEvent('page', { predicate: p => p.url().includes('/onboarding/') })
  await onboarding.close(); popup = await openNativePopup(worker, profile, extensionId)
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in')
  assert.equal((await popup.configureConnection({ name: 'Synthetic API', apiUrl: api.url, webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true)
  await popup.fill('input[type="email"]', api.email); await popup.fill('input[type="password"]', api.password)
  await popup.click('Sign in'); await popup.waitText('No entries yet.'); await popup.dismiss(); popup = null
  await worker.evaluate(language=>chrome.storage.local.set({'palladin.ui.preferences':{language,theme:'system'}}),language);
  const page = await context.newPage(); const cdp=await context.newCDPSession(page);
  async function visualVariants(frame, name, stage) {
    for (const theme of ['light','dark']) {
      await page.emulateMedia({colorScheme:theme});
      await frame.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
      await page.waitForTimeout(350);
      const geometry=await frame.evaluate(()=>{
        const footer=document.querySelector('.capture-review-footer'), header=document.querySelector('.popup-header');
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,header:header.getBoundingClientRect().height,
          buttons:[...footer.querySelectorAll('button')].map(button=>button.getBoundingClientRect().width)};
      });
      assert(geometry.scroll<=geometry.width,'localized review has no horizontal overflow');
      assert.equal(geometry.header,68);
      if(stage==='review')assert.equal(geometry.buttons[0],geometry.buttons[1],'localized footer halves');
      await page.screenshot({path:path.join(artifacts,`${name}-${stage}-${language}-${theme}.png`),clip:await page.locator('palladin-capture').last().boundingBox()});
    }
    await page.emulateMedia({colorScheme:'light'});
    await frame.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  }
  async function openReview(name) {
    let review;
    await wait(async()=>{review=(await cdp.send('Accessibility.getFullAXTree')).nodes.find(n=>!n.ignored&&n.role?.value==='button'&&n.name?.value===label('Review'));return !!review},'closed Review');
    await page.waitForTimeout(650);
    const hosts=page.locator('palladin-capture'); assert.equal(await hosts.last().evaluate(h=>h.shadowRoot),null);
    const before=await hosts.last().boundingBox();
    let model;
    await wait(async()=>{review=(await cdp.send('Accessibility.getFullAXTree')).nodes.find(n=>!n.ignored&&n.role?.value==='button'&&n.name?.value===label('Review'));if(!review)return false;try{model=(await cdp.send('DOM.getBoxModel',{backendNodeId:review.backendDOMNodeId})).model;return true}catch{return false}},'live notice button');
    await page.mouse.click((model.content[0]+model.content[4])/2,(model.content[1]+model.content[5])/2);
    await wait(()=>page.frames().some(f=>f.url().includes('/capture-review/')),'inline frame');
    const frame=page.frames().find(f=>f.url().includes('/capture-review/'));
    await frame.locator('.capture-review[data-stage="review"]').waitFor(); await page.waitForTimeout(800);
    const box=await hosts.last().boundingBox(); assert(Math.abs(box.y-before.y)<1&&Math.abs(box.x+box.width-before.x-before.width)<1,'same notification anchor');
    assert.equal(await frame.locator('.popup-header').evaluate(el=>el.getBoundingClientRect().height),68,'approved header height');
    await page.screenshot({path:path.join(artifacts,`${name}-review.png`),clip:await page.locator('palladin-capture').last().boundingBox()}); await visualVariants(frame,name,'review'); return frame;
  }
  async function saved(frame,name,count,verify) {
    await wait(()=>api.writes.length===count+1,'encrypted write');
    const write=api.writes.at(-1), plaintext=await api.decrypt(write); verify(plaintext,write);
    assert(![pan,key,'MatrixPassword!001','MatrixPassword!002'].some(s=>JSON.stringify(write.request).includes(s)),'encrypted request');
    await frame.getByRole('button',{name:label('Done'),exact:true}).waitFor(); await page.waitForTimeout(800);
    assert.equal(await frame.locator('.capture-review input').count(),0,'saved state clears inputs');
    await page.screenshot({path:path.join(artifacts,`${name}-saved.png`),clip:await page.locator('palladin-capture').last().boundingBox()});
    assert((await page.locator('palladin-capture').last().boundingBox()).height<350,'compact saved state');
    await visualVariants(frame,name,'saved');
    await frame.locator('.capture-review-identity-link').click();
    popup=await attachNativePopup(profile,extensionId); await popup.waitText(plaintext.memberLabel);
    // Inspect the read-only navigation contract through the genuine native surface.
    assert(await nativeDestinationMatches(profile,extensionId,write),'thumbnail opens exact worker-derived saved item');
    await popup.dismiss();popup=null; console.log(`PASS: ${name} inline save and saved thumbnail`); return write;
  }
  const failures=[];const run=async(name,fn)=>{try{await fn()}catch(error){failures.push(name);console.error('FAIL:',name,error.message);try{await popup?.dismiss()}catch{}popup=null}};
  let original;
  for(const [name,password] of [['login-create','MatrixPassword!001'],['login-update','MatrixPassword!002']]) {
    if(!selected(name))continue;
    await page.goto('https://login.example.test/login?mode=spa');
    await page.getByLabel('Username',{exact:true}).fill('matrix-user'); await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Submit',exact:true}).click();
    const frame=await openReview(name), count=api.writes.length;
    await frame.getByRole('button',{name:label(name==='login-create'?'Save login':'Update password'),exact:true}).click();
    const write=await saved(frame,name,count,(plain,write)=>{assert(plain.content.password===password,'password roundtrip');if(original){assert.equal(write.action,'updated');assert.equal(write.entryId,original.entryId)}});
    original??=write;
  }
  for(const [name,cvv,year] of [['card-create','739','2031'],['card-update','913','2035']]) {
    if(!selected(name))continue;
    await run(name,async()=>{await page.goto(`https://payment.example.test/card?${name}`);await page.waitForTimeout(500);
    for(const [autocomplete,value] of [['cc-number',pan],['cc-name','Synthetic Cardholder'],['cc-exp-month','12'],['cc-exp-year',year],['cc-csc',cvv]]) await page.locator(`[autocomplete="${autocomplete}"]`).fill(value);
    await page.getByRole('heading').click();await page.waitForTimeout(700);
    const frame=await openReview(name),count=api.writes.length;
    if(name==='card-update')assert.equal(await frame.getByRole('combobox',{name:label('Existing card entry')}).inputValue(),'Visa','unique exact card auto-selected');
    assert(await frame.locator('input[type="password"][maxlength="4"]').inputValue()===cvv,'captured CVV');
    for(const fieldLabel of [label('Card number'),label('CVV / CVC')]){await frame.getByRole('button',{name:language==='pl'?`Pokaż ${fieldLabel}`:`Show ${fieldLabel}`,exact:true}).click();assert.equal(await frame.getByLabel(fieldLabel,{exact:true}).getAttribute('type'),'text');await frame.getByRole('button',{name:language==='pl'?`Ukryj ${fieldLabel}`:`Hide ${fieldLabel}`,exact:true}).click();assert.equal(await frame.getByLabel(fieldLabel,{exact:true}).getAttribute('type'),'password');}
    await page.waitForTimeout(400);await page.screenshot({path:path.join(artifacts,`${name}-fields.png`),clip:await page.locator('palladin-capture').last().boundingBox()});
    await frame.getByRole('button',{name:label(name==='card-create'?'Save card':'Update card'),exact:true}).click();
    const write=await saved(frame,name,count,(plain,write)=>{assert(plain.content.cardNumber===pan&&plain.content.cvv===cvv,'card roundtrip');if(name==='card-update'){assert.equal(write.action,'updated');assert.equal(write.entryId,original.entryId)}});
    if(name==='card-create')original=write;});
  }
  if(selected('key')) {
  await page.goto('https://keys.example.test/key');await page.waitForTimeout(600);await page.getByRole('button',{name:'Generate'}).click();
  {const frame=await openReview('key'),count=api.writes.length;await frame.getByRole('button',{name:label('Save key'),exact:true}).click();await saved(frame,'key',count,plain=>assert(plain.content.value===key,'key roundtrip'));}
  }
  if(selected('oauth')) {
  await page.goto('https://app.example.test/oauth');await page.getByRole('link',{name:'Continue with Google'}).click();await page.getByRole('link',{name:'Allow'}).click();
  {const frame=await openReview('oauth'),count=api.writes.length;
    assert(await frame.getByRole('img',{name:'Google',exact:true}).evaluate(image=>image.complete&&image.naturalWidth>0),'Bundled provider logo loads without catalog response');
    await frame.getByRole('combobox',{name:label('Which Google account did you use?')}).click();
    await frame.getByRole('option').last().click();
    assert.equal(await frame.getByRole('combobox',{name:label('Save to Vault'),exact:true}).innerText(),'Personal','default writable Vault preselected');
    await frame.getByRole('button',{name:label('Remember method'),exact:true}).click();
    await saved(frame,'oauth',count,plain=>assert(plain.content.customFields.some(f=>f.type==='palladin.signin.v2'&&f.value.provider==='google'),'OAuth method encrypted'));}
  }
  if(selected('pending-draft')) {
  await page.goto('https://pending-draft.example.test/login?mode=spa');
  await page.getByLabel('Username',{exact:true}).fill('pending-user');
  await page.getByLabel('Password',{exact:true}).fill('SyntheticPending!001');
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  { const frame=await openReview('pending-draft'),count=api.writes.length;
    await frame.getByRole('combobox',{name:label('Save to Vault')}).click();
    await frame.getByRole('option',{name:'Team',exact:true}).click();
    await wait(()=>frame.getByRole('button',{name:label('Save login'),exact:true}).isEnabled(),'selected Vault form ready');
    await frame.getByRole('textbox',{name:label('Name'),exact:true}).fill('Edited pending login');
    await frame.getByLabel(label('Username'),{exact:true}).fill('edited-pending-user');
    await frame.getByLabel(label('Password'),{exact:true}).fill('SyntheticEdited!002');
    await frame.locator('.capture-custom-fields > summary').click();
    await frame.getByRole('button',{name:label('Add field'),exact:true}).click();
    await frame.getByLabel(label('Value of additional field 1'),{exact:true}).fill('Unfinished custom value');
    assert.equal(await frame.getByLabel(label('Password'),{exact:true}).inputValue(),'SyntheticEdited!002','inline edited password before transfer');
    await frame.locator('.capture-review-identity-link').click();
    popup=await attachNativePopup(profile,extensionId);
    await popup.waitButton(label('Save login'));
    assert.equal(await popup.secretCaptureFieldsMatch({'input[type="password"]':'SyntheticEdited!002'}),true,'edited password survives handoff');
    assert.equal(await popup.secretCaptureFieldsMatch({'input[aria-label="Value of additional field 1"]':'Unfinished custom value'}),true,'partial custom value survives handoff');
    assert.equal(await popup.secretCaptureFieldsMatch({'input[aria-label="Name of additional field 1"]':''}),true,'empty custom name survives handoff');
    assert.equal(await popup.hasText('Team'),true,'chosen destination survives');
    assert.equal(api.writes.length,count,'draft navigation does not save');
    await popup.click(label('Additional fields'),'DisclosureTriangle');
    await popup.fill('input[aria-label="Name of additional field 1"]','Completed custom field');
    await popup.click(label('Save login'));
    await wait(()=>api.writes.length===count+1,'native handoff encrypted save');
    const plain=await api.decrypt(api.writes.at(-1));
    assert.equal(plain.content.password,'SyntheticEdited!002');
    assert.equal(plain.content.username,'edited-pending-user');
    assert.equal(plain.content.customFields[0].value,'Unfinished custom value');
    assert.equal(api.writes.at(-1).vaultId,api.vaults[1].detail.id,'native save uses selected Vault');
    await popup.dismiss(); popup=null;
    console.log('PASS: edited pending thumbnail preserves partial fields and destination without mutation, native save encrypts edits');
  }
  }
  assert.deepEqual(api.errors,[]);assert.deepEqual(failures,[],'All inline scenarios pass');

} finally { popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true }) }

function fixture(url) {
 const html=body=>`<!doctype html><html><body><h1>Synthetic capture</h1>${body}</body></html>`;
 if(url.hostname==='accounts.google.com')return html('<a href="https://app.example.test/callback?code=synthetic-code&state=synthetic-state">Allow</a>');
 if(url.pathname==='/oauth')return html('<a href="https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&redirect_uri=https%3A%2F%2Fapp.example.test%2Fcallback&state=synthetic-state">Continue with Google</a>');
 if(url.pathname==='/callback')return html('Signed in');
 if(url.pathname==='/card')return html('<form>'+['cc-number','cc-name','cc-exp-month','cc-exp-year','cc-csc'].map(a=>`<input autocomplete="${a}">`).join('')+'</form>');
 if(url.pathname==='/key')return html(`<section><h2>API key</h2><button onclick="document.querySelector('output').textContent='${key}'">Generate</button><output></output></section>`);
 return fixturePage(url);
}
function fixturePage() {
 return `<!doctype html><html lang="en"><body><h1>Synthetic login</h1><form>
 <label>Username<input name="username" autocomplete="username"></label>
 <label>Password<input type="password" name="password" autocomplete="current-password"></label>
 <button type="submit">Submit</button></form><script>document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('form').outerHTML='<div role="status">Successfully signed in</div>'});</script></body></html>`;
}

async function nativeDestinationMatches(profile,extensionId,write) {
  const [port,endpoint]=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');
  const ws=new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  let id=0;const pending=new Map();
  ws.onmessage=event=>{const message=JSON.parse(event.data),call=pending.get(message.id);if(call){pending.delete(message.id);clearTimeout(call.timer);message.error?call.reject(Error('Native destination inspection failed')):call.resolve(message.result)}};
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const next=++id,timer=setTimeout(()=>reject(Error('Native destination inspection timeout')),5000);pending.set(next,{resolve,reject,timer});ws.send(JSON.stringify({id:next,method,params,...(sessionId?{sessionId}:{})}))});
  try {
    const target=(await send('Target.getTargets')).targetInfos.find(t=>t.url===`chrome-extension://${extensionId}/src/popup/index.html`);assert(target);
    const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const result=await send('Runtime.evaluate',{expression:`(async()=>{const snapshot=await chrome.runtime.sendMessage({type:'popup/view/get'});return snapshot?.state?.selected?.id===${JSON.stringify(write.entryId)}&&snapshot?.state?.selected?.vaultId===${JSON.stringify(write.vaultId)}})()`,awaitPromise:true,returnByValue:true},sessionId);
    await send('Target.detachFromTarget',{sessionId});return result.result.value===true;
  } finally {ws.close();for(const call of pending.values())clearTimeout(call.timer)}
}
