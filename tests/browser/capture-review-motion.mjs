import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Synthetic delayed worker responses with the production host, private frame
// transport and React renderer. No real website or credentials are inspected.
const server = await createServer({ configFile: false, root: process.cwd(), define: { __PALLADIN_TARGET__: '"chromium"' }, optimizeDeps: {include:['react','react-dom/client','react/jsx-dev-runtime']}, resolve: { alias: { '@shared': path.resolve('src/shared') } }, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const artifacts=path.resolve('test-results/capture-review-motion'); await mkdir(artifacts,{recursive:true});
  let kind = 'secret';
  await page.route('https://capture.example.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="notice-sentinel" style="position:fixed;left:764px;top:16px;width:420px;height:260px;background:magenta">Synthetic original notice</div></body></html>' });
    if (url.pathname === '/src/capture-review/index.html') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js'; const {createRoot} = ReactDOM;
      import { PopupPreferencesProvider } from '/src/popup/preferences.tsx';
      import { CaptureFrameApp } from '/src/capture-review/App.tsx';
      import { bindCaptureFrame } from '/src/capture-review/frame-connection.ts';
      import '/src/popup/popup.css'; import '/src/popup/redesign.css'; import '/src/capture-review/frame.css';
      window.React = React;
      window.frameSamples=[];
      const sampleFrame=()=>{const header=document.querySelector('.popup-header')?.getBoundingClientRect();window.frameSamples.push({at:performance.now(),background:getComputedStyle(document.body).backgroundColor,header:header?{height:header.height,top:header.top,width:header.width}:null,stage:document.querySelector('.capture-review')?.dataset.stage,viewport:innerHeight,footerBottom:document.querySelector('.capture-review-footer')?.getBoundingClientRect().bottom,done:[...document.querySelectorAll('button')].some(b=>b.textContent==='Done')});requestAnimationFrame(sampleFrame);};sampleFrame();
      const listeners = [];
      const secretReview = { status: 'review', id: 'candidate', origin: 'https://example.test', candidate: { kind: 'key', value: 'synthetic-capture-secret' }, vaults: [{ id: 'vault', name: 'Personal', isDefault: true }] };
      const review = ${kind === 'secret' ? 'secretReview' : JSON.stringify({ status:'review',review:{kind:'credential',prompt:{id:'capture',site:'example.test',state:'ready',targets:[{id:'target',action:'create',label:'Personal',vaultLabel:'Personal'}],defaultTargetId:'target'},entry:{entryType:'credential',label:'Example',username:'synthetic-user',password:'synthetic-password',url:'https://example.test'}}})};
      bindCaptureFrame(window, () => ({
        postMessage(message) {
          if(message.type === 'connect') queueMicrotask(() => listeners.forEach(fn => fn({type:'connected',ok:true})));
          if(message.type === 'command') { const reply = () => listeners.forEach(fn => fn({type:'result',requestId:message.requestId,result:message.envelope.command.type === 'get' ? review : {status:'saved'}})); if(message.envelope.command.type === 'get') window.releaseReview=reply; else setTimeout(reply,0); }
        }, disconnect() {}, onMessage:{addListener:fn => listeners.push(fn)}, onDisconnect:{addListener() {}}
      }), connection => createRoot(document.getElementById('root')).render(React.createElement(PopupPreferencesProvider,null,React.createElement(CaptureFrameApp,{connection}))), () => {});
    </script></body></html>` });
    const response = await fetch(new URL(url.pathname + url.search, server.resolvedUrls.local[0]));
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'text/javascript', body: Buffer.from(await response.arrayBuffer()) });
  });
  page.on('pageerror', error => console.error(error.message));
  for (kind of ['secret','login']) for (const theme of ['light','dark']) for (const reduced of [false, true]) {
    await page.emulateMedia({ colorScheme:theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.goto('https://capture.example.test/fixture');
    const framePromise=page.waitForEvent('framenavigated',{predicate:frame=>frame.url().includes('/capture-review/')});
    await page.evaluate(async kind => {
      const { openInlineCaptureReview } = await import('/src/content/isolated/capture-review-host.ts');
      const listeners = [];
      window.chrome = {runtime:{getURL:path => new URL(path,location.origin).href,connect:() => ({
        postMessage: message => { if(message.type === 'mint') queueMicrotask(() => listeners.forEach(fn => fn({type:'minted',capability:'a'.repeat(64)}))); },
        disconnect(){}, onMessage:{addListener:fn => listeners.push(fn)}, onDisconnect:{addListener(){}},
      })}};
      window.samples = []; window.readyAt = null;
      const sample = () => {
        const host = document.querySelector('palladin-capture');
        if(host) {
          window.samples.push({at:performance.now(),height:host.getBoundingClientRect().height});
        }
        window.sampling = requestAnimationFrame(sample);
      }; sample();
      void openInlineCaptureReview(document,'document',kind,'capture',{left:764,top:16,width:420,height:260,onReady:() => {window.readyAt=performance.now();document.getElementById('notice-sentinel').remove();}});
    }, kind);
    const frame = await framePromise;
    await frame.waitForFunction(()=>typeof window.releaseReview==='function');
    await page.screenshot({path:path.join(artifacts,`${kind}-${theme}-${reduced}-loading.png`)});
    const pixel=await page.screenshot({clip:{x:800,y:200,width:1,height:1}});
    const rgba=await page.evaluate(async data=>{const image=new Image();image.src=data;await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(0,0,1,1).data];},`data:image/png;base64,${pixel.toString('base64')}`);
    assert.deepEqual(rgba,[255,0,255,255],'actual pixels preserve original notice while preferences and scoped review load');
    await frame.evaluate(()=>window.releaseReview());
    await page.waitForFunction(() => window.readyAt !== null, null, { timeout: 10000 });
    await page.waitForTimeout(750);
    const expansion = await page.evaluate(() => window.samples);
    await frame.waitForFunction(()=>{const logo=document.querySelector('.brand-logo');return logo.complete&&logo.naturalWidth>0;});
    console.log('Expansion heights', reduced, Math.min(...expansion.map(s=>s.height)), expansion.at(-1).height);
    assert(expansion.every(s => s.height >= 259), 'opening never contracts to a header-only loading frame');
    const closeOffset=await frame.locator('.popup-header > button').evaluate(button=>{const box=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();return {x:(icon.left+icon.right-box.left-box.right)/2,y:(icon.top+icon.bottom-box.top-box.bottom)/2};});
    assert(Math.abs(closeOffset.x)<0.5&&Math.abs(closeOffset.y)<0.5,'close icon stays centered inside its button');
    const headerClip={x:770,y:22,width:408,height:56};
    const headerBefore=await page.screenshot({clip:headerClip});
    await page.screenshot({path:path.join(artifacts,`${kind}-${theme}-${reduced}-review.png`)});
    await page.evaluate(() => {window.samples=[];});
    await frame.getByRole('button', { name: kind === 'secret' ? 'Save key' : 'Save login', exact: true }).click();
    await frame.getByRole('button', { name: 'Done', exact: true }).waitFor();
    const savedAt = await page.evaluate(() => performance.now());
    for(let sample=0;sample<6;sample++) {
      const headerDuring=await page.screenshot({clip:headerClip});
      assert(headerBefore.equals(headerDuring),'review→saved keeps rendered header pixels unchanged, including secret remount');
      await page.screenshot({path:path.join(artifacts,`${kind}-${theme}-${reduced}-saved-${sample}.png`)});
    }
    await page.waitForTimeout(750);
    const collapse = await page.evaluate(() => window.samples);
    const final = collapse.at(-1).height;
    const frames=await frame.evaluate(()=>window.frameSamples);
    assert(frames.filter(s=>!s.header).length>0,'sample pending scoped review');
    assert(frames.filter(s=>!s.header).every(s=>s.background==='rgba(0, 0, 0, 0)'), 'loading frame stays transparent over the original notice');
    assert(frames.filter(s=>s.header).length>10,'sample real child frames across both transitions');
    assert(frames.filter(s=>s.header).every(s=>s.header.height===68 && s.header.top===0 && s.header.width===420), 'header geometry stays fixed on every animation frame');
    const savedFrames=frames.filter(s=>s.stage==='saved');
    if(!reduced) {
      assert(savedFrames.filter(s=>s.at<savedFrames[0].at+250).every(s=>!s.done),'footer changes only after collapse');
      assert(savedFrames.every(s=>Math.abs(s.footerBottom-s.viewport)<2),'footer follows the bottom edge throughout collapse');
    }
    console.log('Collapse heights', reduced, Math.min(...collapse.map(s=>s.height)), final);
    assert(collapse.filter(s=>s.at>savedAt+380).every(s=>Math.abs(s.height-final)<1), 'saved resize settles in one 320ms transition');
    assert(collapse.every(s => s.height >= final - 1), 'saved transition never undershoots and rebounds');
    assert.equal(await frame.locator('input,textarea').count(),0,'saved state removes secret editor nodes immediately');
    assert.equal(await frame.locator('.popup-header').evaluate(n=>n.getBoundingClientRect().height),68);
  }
  console.log('PASS production capture motion: no startup contraction or saved-state rebound, stable 68px header, reduced motion');
} finally { await browser.close(); await server.close(); }
