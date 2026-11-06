import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Synthetic hostile-page geometry, reduced from the independently reproduced
// overlay and opacity-ancestor bypasses. No production site or real credentials.
const server = await createServer({ configFile: false, root: process.cwd(), define: { __PALLADIN_TARGET__: '"chromium"' }, resolve: {
  alias: { '@shared': path.resolve('src/shared') },
}, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  await page.addInitScript(() => { globalThis.__PALLADIN_TARGET__ = 'chromium'; });
  await page.goto(server.resolvedUrls.local[0]);
  const results = await page.evaluate(async () => {
    const { captureFrameVisible } = await import('/src/content/isolated/capture-review-host.ts');
    const host = document.createElement('palladin-capture');
    host.style.cssText = 'position:fixed;left:10px;top:10px;width:420px;height:600px;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe'); frame.style.cssText = 'width:100%;height:100%;border:0';
    shadow.append(frame); document.documentElement.append(host);
    const surface = { host, shadow, frame };
    const check = () => captureFrameVisible(document, surface, { x:200, y:500, keyboard:false, at:Date.now() });
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:white;pointer-events:none;z-index:2147483647';
    document.documentElement.append(overlay);
    const coveredUnpromoted = check(); overlay.remove();
    const wrapper = document.createElement('div'); wrapper.style.opacity = '0'; document.documentElement.append(wrapper); wrapper.append(host);
    const opacityAncestor = check();
    document.documentElement.append(host); wrapper.remove();
    host.setAttribute('popover', 'manual'); host.style.margin = '0'; host.style.padding = '0'; host.style.border = '0'; host.showPopover();
    const visiblePopover = check();
    document.documentElement.append(overlay);
    const ordinaryOverlayCannotCover = check();
    host.remove(); overlay.remove();
    return { coveredUnpromoted, opacityAncestor, visiblePopover, ordinaryOverlayCannotCover };
  });
  assert.equal(results.coveredUnpromoted, false, 'Never authorize a page-overlayable unpromoted review');
  assert.equal(results.opacityAncestor, false, 'Reparenting beneath an opacity ancestor revokes ownership');
  assert.equal(results.visiblePopover, true, 'An unobscured owned top-layer review remains usable');
  assert.equal(results.ordinaryOverlayCannotCover, true, 'Top-layer review renders above ordinary pointer-events:none overlays');

  const interference = await page.evaluate(async () => {
    const { createCaptureReviewGuard } = await import('/src/content/isolated/capture-review-host.ts');
    const host = document.createElement('palladin-capture');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'position:fixed;left:10px;top:10px;width:420px;height:600px;margin:0;padding:0;border:0';
    const shadow = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe'); frame.style.cssText = 'width:100%;height:100%;border:0';
    shadow.append(frame); document.documentElement.append(host); host.showPopover();
    let revoked = false;
    const guard = createCaptureReviewGuard(document, { host, shadow, frame }, () => { revoked = true; });
    const overlay = document.createElement('div'); overlay.setAttribute('popover', 'manual');
    overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;border:0;background:white;pointer-events:none';
    document.documentElement.append(overlay); overlay.showPopover();
    const covered = guard.attest({ x:200, y:500, keyboard:false, at:Date.now() });
    overlay.hidePopover(); const immediatelyAfter = guard.attest();
    await new Promise(resolve => setTimeout(resolve, 350));
    const recovered = guard.attest();
    overlay.showPopover(); overlay.hidePopover(); overlay.showPopover();
    const repeated = guard.attest();
    guard.stop(); host.remove(); overlay.remove();
    return { covered, immediatelyAfter, recovered, repeated, revoked };
  });
  assert.deepEqual(interference, { covered:false, immediatelyAfter:false, recovered:true, repeated:false, revoked:true }, 'Foreign top-layer overlays poison actions, recover after cooldown, and revoke on repeated interference');

  await page.route('https://capture.example.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><button style="position:fixed;left:20px;top:700px" onclick="window.outsideClicks=(window.outsideClicks||0)+1">Outside</button></body></html>'});
    if (url.pathname === '/src/capture-review/index.html') return route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><button onclick="window.reviewClicks=(window.reviewClicks||0)+1">Review action</button><script type="module">
      import { bindCaptureFrame } from '/src/capture-review/frame-connection.ts';
      const listeners = [];
      bindCaptureFrame(window, () => ({
        postMessage(message) { if (message.type === 'connect') queueMicrotask(() => listeners.forEach(fn => fn({type:'connected',ok:true}))); },
        disconnect() {}, onMessage: { addListener: fn => listeners.push(fn) }, onDisconnect: { addListener() {} }
      }), connection => { connection.ready(); setTimeout(() => connection.resize(500), 200); }, () => document.body.replaceChildren());
    </script></body></html>`});
    const response = await fetch(new URL(url.pathname + url.search, server.resolvedUrls.local[0]));
    await route.fulfill({status:response.status,contentType:response.headers.get('content-type') ?? 'text/javascript',body:await response.text()});
  });
  for (const modalFallback of [false, true]) for (const reduced of [false, true]) {
    await page.emulateMedia({reducedMotion:reduced ? 'reduce' : 'no-preference'});
    await page.goto('https://capture.example.test/fixture');
    const motion = await page.evaluate(async ({ reduced, modalFallback }) => {
      if (modalFallback) delete HTMLElement.prototype.showPopover;
      const { openInlineCaptureReview } = await import('/src/content/isolated/capture-review-host.ts');
      const listeners = []; window.ownerListeners = listeners; window.ownerMessages = []; window.ownerDisconnected = false;
      window.chrome = {runtime:{getURL:path => new URL(path,location.origin).href,connect:() => ({
        postMessage: message => { window.ownerMessages.push(message); if(message.type === 'mint') queueMicrotask(() => listeners.forEach(fn => fn({type:'minted',capability:'a'.repeat(64)}))); },
        disconnect(){ window.ownerDisconnected = true; }, onMessage:{addListener:fn => listeners.push(fn)}, onDisconnect:{addListener(){}},
      })}};
      let readyCount = 0;
      const opened = await openInlineCaptureReview(document,'document','login','capture',{left:764,top:16,width:420,height:200,onReady:() => readyCount++});
      const host = document.querySelector('palladin-capture');
      const initial = host.getBoundingClientRect();
      await new Promise(resolve => setTimeout(resolve,260));
      const during = host.getBoundingClientRect();
      await new Promise(resolve => setTimeout(resolve,350));
      const final = host.getBoundingClientRect();
      const transition = getComputedStyle(host).transitionDuration;
      return {opened,readyCount,initialHeight:initial.height,duringHeight:during.height,finalHeight:final.height,
        initialRight:initial.right,finalRight:final.right,initialTop:initial.top,finalTop:final.top,transition,reduced};
    },{ reduced, modalFallback });
    assert.equal(motion.opened,true); assert.equal(motion.readyCount,1);
    assert.equal(motion.initialHeight,200); assert.equal(motion.finalHeight,500);
    assert.equal(motion.finalRight,motion.initialRight); assert.equal(motion.finalTop,motion.initialTop);
    if(reduced) { assert.equal(motion.duringHeight,500); assert.equal(motion.transition,'0s'); }
    else { assert(motion.duringHeight>200 && motion.duringHeight<500); assert.equal(motion.transition,'0.32s'); }
    if (modalFallback) {
      const reviewFrame = page.frames().find(frame => frame.url().includes('/src/capture-review/index.html'));
      await reviewFrame.getByRole('button', { name: 'Review action' }).click();
      assert.equal(await reviewFrame.evaluate(() => window.reviewClicks), 1, 'Trusted actions remain usable inside the modal frame');
      await page.mouse.click(40, 710);
      assert.equal(await page.evaluate(() => window.outsideClicks ?? 0), 0, 'The browser blocks background clicks while reviewing');
      const overlays = await page.evaluate(async () => {
        const attest = id => {
          window.ownerListeners.forEach(fn => fn({ type: 'attest', requestId: id }));
          return window.ownerMessages.find(message => message.requestId === id)?.ok;
        };
        const ordinary = document.createElement('div');
        ordinary.style.cssText = 'position:fixed;inset:0;background:white;pointer-events:none;z-index:2147483647';
        document.documentElement.append(ordinary);
        const ordinarySafe = attest('ordinary');
        const foreign = document.createElement('dialog');
        foreign.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;pointer-events:none';
        document.documentElement.append(foreign); foreign.showModal();
        const foreignBlocked = attest('foreign');
        foreign.close(); foreign.remove(); ordinary.remove();
        await new Promise(resolve => setTimeout(resolve,350));
        const recovered = attest('recovered');
        const flash = document.createElement('dialog'); document.documentElement.append(flash);
        flash.showModal(); flash.close();
        const rapidBlocked = attest('rapid');
        flash.remove();
        await new Promise(resolve => setTimeout(resolve,350));
        return { ordinarySafe, foreignBlocked, recovered, rapidBlocked, recoveredAfterFlash: attest('after-flash') };
      });
      assert.deepEqual(overlays, { ordinarySafe: true, foreignBlocked: false, recovered: true, rapidBlocked: false, recoveredAfterFlash: true });
      await reviewFrame.getByRole('button', { name: 'Review action' }).click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('palladin-capture'));
      assert.equal(await page.evaluate(() => window.ownerDisconnected), true, 'Escape tears down worker ownership and the frame');
    } else await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

  }
  console.log('PASS capture-review host: overlay/ancestry guards, interference cooldown, same-position 320ms resize and reduced motion; modal fallback trusted actions, background inertness and Escape cleanup');

} finally { await browser.close(); await server.close(); }
