import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Synthetic delayed worker responses with the production host, private frame
// transport and React renderer. No real website or credentials are inspected.
const server = await createServer({ configFile: false, root: process.cwd(), define: { __PALLADIN_TARGET__: '"chromium"' }, optimizeDeps: {include:['react','react-dom/client','react/jsx-dev-runtime']}, resolve: { alias: { '@shared': path.resolve('src/shared') } }, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  let kind = 'secret';
  await page.route('https://capture.example.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
    if (url.pathname === '/src/capture-review/index.html') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js'; const {createRoot} = ReactDOM;
      import { CaptureFrameApp } from '/src/capture-review/App.tsx';
      import { bindCaptureFrame } from '/src/capture-review/frame-connection.ts';
      import '/src/popup/popup.css'; import '/src/popup/redesign.css'; import '/src/capture-review/frame.css';
      window.React = React;
      const listeners = [];
      const secretReview = { status: 'review', id: 'candidate', origin: 'https://example.test', candidate: { kind: 'key', value: 'synthetic-capture-secret' }, vaults: [{ id: 'vault', name: 'Personal', isDefault: true }] };
      const review = ${kind === 'secret' ? 'secretReview' : JSON.stringify({ status:'review',review:{kind:'credential',prompt:{id:'capture',site:'example.test',state:'ready',targets:[{id:'target',action:'create',label:'Personal',vaultLabel:'Personal'}],defaultTargetId:'target'},entry:{entryType:'credential',label:'Example',username:'synthetic-user',password:'synthetic-password',url:'https://example.test'}}})};
      bindCaptureFrame(window, () => ({
        postMessage(message) {
          if(message.type === 'connect') queueMicrotask(() => listeners.forEach(fn => fn({type:'connected',ok:true})));
          if(message.type === 'command') setTimeout(() => listeners.forEach(fn => fn({type:'result',requestId:message.requestId,result:message.envelope.command.type === 'get' ? review : {status:'saved'}})), message.envelope.command.type === 'get' ? 350 : 0);
        }, disconnect() {}, onMessage:{addListener:fn => listeners.push(fn)}, onDisconnect:{addListener() {}}
      }), connection => createRoot(document.getElementById('root')).render(React.createElement(CaptureFrameApp,{connection})), () => {});
    </script></body></html>` });
    const response = await fetch(new URL(url.pathname + url.search, server.resolvedUrls.local[0]));
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'text/javascript', body: await response.text() });
  });
  page.on('pageerror', error => console.error(error.message));
  for (kind of ['secret','login']) for (const reduced of [false, true]) {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.goto('https://capture.example.test/fixture');
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
          const header = window.frames[0]?.document.querySelector('.popup-header')?.getBoundingClientRect();
          window.samples.push({at:performance.now(),height:host.getBoundingClientRect().height, background:window.frames[0]?.document.body ? getComputedStyle(window.frames[0].document.body).backgroundColor : null, header:header ? {height:header.height,top:header.top,width:header.width} : null});
        }
        window.sampling = requestAnimationFrame(sample);
      }; sample();
      void openInlineCaptureReview(document,'document',kind,'capture',{left:764,top:16,width:420,height:260,onReady:() => {window.readyAt=performance.now();}});
    }, kind);
    await page.waitForFunction(() => window.readyAt !== null, null, { timeout: 10000 });
    const frame = page.frames().find(frame => frame.url().includes('/capture-review/'));
    await page.waitForTimeout(750);
    const expansion = await page.evaluate(() => window.samples);
    assert(expansion.filter(s=>!s.header&&s.background).every(s=>s.background==='rgba(0, 0, 0, 0)'), 'loading frame stays transparent over the original notice');
    console.log('Expansion heights', reduced, Math.min(...expansion.map(s=>s.height)), expansion.at(-1).height);
    assert(expansion.every(s => s.height >= 259), 'opening never contracts to a header-only loading frame');
    await page.evaluate(() => {window.samples=[];});
    await frame.getByRole('button', { name: kind === 'secret' ? 'Save key' : 'Save login', exact: true }).click();
    await frame.getByRole('button', { name: 'Done', exact: true }).waitFor();
    const savedAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(750);
    const collapse = await page.evaluate(() => window.samples);
    const final = collapse.at(-1).height;
    assert([...expansion,...collapse].filter(s=>s.header).every(s=>s.header.height===68 && s.header.top===0 && s.header.width===420), 'header geometry stays fixed on every animation frame');
    console.log('Collapse heights', reduced, Math.min(...collapse.map(s=>s.height)), final);
    assert(collapse.filter(s=>s.at>savedAt+380).every(s=>Math.abs(s.height-final)<1), 'saved resize settles in one 320ms transition');
    assert(collapse.every(s => s.height >= final - 1), 'saved transition never undershoots and rebounds');
    assert.equal(await frame.locator('input,textarea').count(),0,'saved state removes secret editor nodes immediately');
    assert.equal(await frame.locator('.popup-header').evaluate(n=>n.getBoundingClientRect().height),68);
  }
  console.log('PASS production capture motion: no startup contraction or saved-state rebound, stable 68px header, reduced motion');
} finally { await browser.close(); await server.close(); }
