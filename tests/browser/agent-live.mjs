import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';

// Only synthetic pages and values. Actual built worker/content routing; runtime
// authorization is substituted here and exercised separately by provider tests.
const directory = 'tests/fixtures/forms/aws-root-identifier-2026-09-18';
const html = await readFile(`${directory}/page.html`, 'utf8');
const css = await readFile(`${directory}/page.css`, 'utf8');
const xPassword = await readFile('tests/fixtures/forms/x-deferred-password-2026-09-20.html', 'utf8');
const allegro = await readFile('tests/fixtures/forms/allegro-login-ad-2026-09-20/page.html', 'utf8');
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-live-'));
let context;
try {
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: 'https://api.example.test', VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1280, height: 2000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route(/^https?:/, route => {
    const url = new URL(route.request().url());
    return url.hostname === 'login.example.test' ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(url.pathname) }) : route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const send = (target, message) => worker.evaluate(({ target, message }) => chrome.tabs.sendMessage(target.id, message, { frameId: 0 }), { target, message });
  async function binding() {
    for (let i = 0; i < 100; i++) {
      const target = await worker.evaluate(async () => {
        for (const tab of await chrome.tabs.query({})) {
          try { const current = await chrome.tabs.sendMessage(tab.id, { channel: 'palladin.tab/current-url' }, { frameId: 0 });
            if (new URL(current.url).hostname === 'login.example.test') return { id: tab.id, ...current };
          } catch { /* Extension-owned pages have no content handler. */ }
        }
        return null;
      });
      if (target) return target;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Synthetic document binding unavailable');
  }
  for (const scenario of ['aws-spa', 'combined', 'combined-disabled', 'carry', 'navigation']) {
    await page.goto(`https://login.example.test/${scenario}`);
    const stages = scenario.startsWith('combined') ? [['credential.username', 'credential.password'], ['credential.totp']]
      : [['credential.username'], scenario === 'carry' ? ['credential.username', 'credential.password'] : ['credential.password'], ['credential.totp']];
    for (const fields of stages) {
      const target = await binding();
      const probe = await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url });
      assert.equal(probe.outcome, 'ready');
      assert.deepEqual(probe.form.steps[0].fields.map(field => field.entryFieldId), fields);
      if (scenario === 'combined-disabled' && fields.includes('credential.password')) {
        assert.equal(await page.locator('button').isDisabled(), true, 'Discovery must not activate the disabled native action');
      }
      const message = { channel: 'palladin.agent-inject/step', documentId: target.documentId, expectedDomain: 'login.example.test', step: probe.form.steps[0],
        ...(scenario === 'carry' && fields.includes('credential.password') ? { requireExistingUsername: true } : {}),
        values: fields.map(entryFieldId => ({ entryFieldId, value: entryFieldId === 'credential.username' ? 'synthetic@example.test' : entryFieldId === 'credential.password' ? 'Synthetic-password!42' : '123456' })) };
      let replayMessage = message;
      if (probe.form.version === 2) {
        const ready = await send(target, { channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId: target.documentId,
          expectedDomain: 'login.example.test', form: probe.form, values: message.values, expiresAt: Date.now() + 10_000,
          ...(message.requireExistingUsername ? { requireExistingUsername: true } : {}) });
        assert.equal(ready.ok, true);
        if (scenario === 'combined-disabled') {
          assert.equal(await page.evaluate(() => globalThis.submitEvents), 0, 'Writing fields must not submit');
          assert.equal(await page.locator('button').isDisabled(), false, 'Only the synthetic framework activates the action');
        }
        replayMessage = { channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 };
        assert.deepEqual(await send(target, replayMessage), { ok: true });
      } else assert.deepEqual(await send(target, message), { ok: true });
      if (scenario === 'navigation') {
        const nextPath = fields.includes('credential.username') ? '/password' : fields.includes('credential.password') ? '/otp' : '/done';
        await page.waitForURL(url => url.pathname === nextPath, { waitUntil: 'domcontentloaded' });
      }
      assert.equal((await send(await binding(), replayMessage)).ok, false, 'A consumed or old-document step cannot repeat');
    }
    const target = await binding();
    assert.deepEqual(await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url }), { outcome: 'no-form' });
    if (scenario === 'carry') assert.equal(await page.evaluate(() => globalThis.identityEvents), 0);
    await page.evaluate(() => { document.body.innerHTML = '<div data-sitekey="synthetic" style="width:200px;height:100px">Security check</div>'; });
    assert.deepEqual(await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url }), { outcome: 'challenge' });
    console.log(`PASS ${scenario}: fresh bound stages, replay denial, no-form and challenge`);
  }
  await page.goto('https://login.example.test/allegro-observed');
  const target = await binding();
  const probe = () => send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url });
  let observed = await probe();
  assert.equal(observed.outcome, 'ready');
  assert.deepEqual(observed.form.steps[0].fields.map(field => field.entryFieldId), ['credential.username', 'credential.password']);
  // Synthetic obstacles verify geometry against the observed form. No production
  // handlers, account values, or iframe contents are replayed.
  await page.evaluate(() => {
    const rect = document.querySelector('#password').getBoundingClientRect();
    const cover = document.createElement('div'); cover.id = 'synthetic-overlay';
    Object.assign(cover.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, background: 'white', zIndex: '9999999' });
    document.body.append(cover);
  });
  assert.notEqual((await probe()).outcome, 'ready');
  await page.evaluate(() => { document.querySelector('#synthetic-overlay').remove(); const captcha = document.createElement('div'); captcha.dataset.sitekey = 'synthetic'; captcha.style.cssText = 'width:200px;height:50px'; document.querySelector('form').append(captcha); });
  assert.equal((await probe()).outcome, 'challenge');
  await page.evaluate(() => { document.querySelector('[data-sitekey]').remove(); document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); globalThis.syntheticSubmitted = true; }); });
  observed = await probe();
  assert.equal(observed.outcome, 'ready');
  const observedReady = await send(target, { channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId: target.documentId, expectedDomain: 'login.example.test', form: observed.form,
    expiresAt: Date.now() + 10_000, values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  assert.equal(observedReady.ok, true);
  assert.deepEqual(await send(target, { channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: observedReady.submitReady, expiresAt: Date.now() + 1000 }), { ok: true });
  assert.equal(await page.evaluate(() => globalThis.syntheticSubmitted), true);
  console.log('PASS observed-allegro: unrelated ad frame, overlay/CAPTCHA rejection, native fill/submit');
  for (const expired of [false, true]) {
    await page.goto('https://login.example.test/deferred-synthetic');
    const deferredTarget = await binding();
    const initial = await send(deferredTarget, { channel: 'palladin.agent-live/probe', documentId: deferredTarget.documentId, targetUrl: deferredTarget.url });
    assert.equal(initial.outcome, 'ready'); assert.equal(initial.form.version, 2);
    const ready = await send(deferredTarget, { channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId: deferredTarget.documentId,
      expectedDomain: 'login.example.test', form: initial.form, expiresAt: Date.now() + 10_000,
      values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }] });
    assert.equal(ready.ok, true);
    assert.deepEqual(await page.evaluate(() => [globalThis.fillEvents, globalThis.submitEvents]), [1, 0]);
    const commit = { channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady,
      expiresAt: Date.now() + (expired ? -1 : 1000) };
    assert.equal((await send(deferredTarget, commit)).ok, !expired);
    assert.equal((await send(deferredTarget, commit)).ok, false);
    assert.equal(await page.evaluate(() => globalThis.submitEvents), expired ? 0 : 1);
  }
  console.log('PASS synthetic-deferred: fill once, real native-action rediscovery, separate commit, replay/expiry rejection');
  for (const route of ['x-password-observed', 'queued-div']) {
    // The sanitized subtree omits production layout classes/resources. A wide
    // synthetic viewport keeps its unstyled SVG/button row visible; this is a
    // mechanism replay, not a claim about the original page geometry.
    await page.setViewportSize({ width: route === 'x-password-observed' ? 2600 : 1280, height: 2000 });
    await page.goto(`https://login.example.test/${route}`);
    const target = await binding();
    const plan = await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url });
    assert.equal(plan.outcome, 'ready'); assert.equal(plan.form.version, 2);
    const ready = await send(target, { channel: 'palladin.agent-live/deferred-fill', pendingId: 'c'.repeat(32), documentId: target.documentId,
      expectedDomain: 'login.example.test', form: plan.form, expiresAt: Date.now() + 10_000,
      values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
    assert.equal(ready.ok, true, JSON.stringify({ ready, state: await page.evaluate(() => ({ identityEvents: globalThis.identityEvents,
      controls: [...document.querySelectorAll('input,button')].map(element => { const rect = element.getBoundingClientRect(); return { tag: element.tagName, type: element.type,
        disabled: element.disabled, filled: element instanceof HTMLInputElement && element.value.length > 0, rect: [rect.x,rect.y,rect.width,rect.height], opacity: getComputedStyle(element).opacity }; }) })) }));
    assert.equal(await page.evaluate(() => globalThis.submitEvents), 0);
    assert.deepEqual(await send(target, { channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }), { ok: true });
    assert.deepEqual(await page.evaluate(() => [globalThis.submitEvents, globalThis.stateAccepted]), [1, true]);
    if (route === 'x-password-observed') assert.equal(await page.evaluate(() => globalThis.identityEvents), 0);
    console.log(`PASS ${route}: single deferred commit after queued state, identity preserved`);
  }

} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }

function fixture(route) {
  if (route === '/x-password-observed' || route === '/queued-div') {
    const observed = route === '/x-password-observed';
    const body = observed ? xPassword : '<div id="login"><input autocomplete="username"><input type="password" autocomplete="current-password"><button type="button">Sign in</button></div>';
    return `<!doctype html><html><head><meta charset="utf-8"><style>input,button{min-height:32px;min-width:180px}</style></head><body>${body}<script>
      // Synthetic handlers on observed structure, never production website JS.
      globalThis.identityEvents=0;globalThis.submitEvents=0;globalThis.stateAccepted=false;
      const identity=document.querySelector('input[autocomplete=username]'),password=document.querySelector('input[type=password]');
      const observed=${JSON.stringify(observed)}; if(observed) identity.value='synthetic@example.test';
      let stateIdentity=identity.value,statePassword='';
      identity.addEventListener('input',()=>{identityEvents++;const value=identity.value;setTimeout(()=>stateIdentity=value,0)});
      identity.addEventListener('change',()=>identityEvents++);
      password.addEventListener('input',()=>{const value=password.value;setTimeout(()=>{statePassword=value;
        if(observed) document.querySelector('form').insertAdjacentHTML('beforeend','<button type="submit">Continue</button>');},0)});
      const complete=event=>{event.preventDefault();submitEvents++;stateAccepted=stateIdentity==='synthetic@example.test'&&statePassword==='Synthetic-password!42'};
      if(observed) document.querySelector('form').addEventListener('submit',complete);else document.querySelector('button').addEventListener('click',complete);
    </script></body></html>`;
  }

  if (route === '/deferred-synthetic') return `<!doctype html><html><head><meta charset="utf-8"><style>form{width:400px}input,button{min-height:32px}input{display:block;margin:16px}</style></head><body>
    <form><input autocomplete="username"><input type="password" style="opacity:0"><div>Continue</div></form><script>
    // Synthetic mechanism only: no claim about X production post-input behavior.
    globalThis.fillEvents=0;globalThis.submitEvents=0;
    const form=document.querySelector('form');document.querySelector('input').addEventListener('input',()=>{fillEvents++;setTimeout(()=>form.insertAdjacentHTML('beforeend','<button type="submit">Continue</button>'),50)});
    form.addEventListener('submit',event=>{event.preventDefault();submitEvents++;form.innerHTML='<p>Neutral destination</p>'});
    </script></body></html>`;

  if (route === '/allegro-observed') return `<!doctype html><html><body>${allegro}</body></html>`;
  const password = '<label>Password<input type="password" autocomplete="current-password"></label><button>Sign in</button>';
  const identity = '<label>Email<input autocomplete="username" type="email"></label>';
  const otp = '<label>Authenticator code<input autocomplete="one-time-code"></label><button>Verify</button>';
  const combined = ['/combined', '/combined-disabled'].includes(route);
  const stage = route === '/password' ? 1 : route === '/otp' ? 2 : route === '/done' ? 3 : combined ? 1 : 0;
  const body = combined ? `<form>${identity}${route === '/combined-disabled' ? password.replace('<button>', '<button disabled>') : password}</form>` : stage === 1 ? `<form>${password}</form>`
    : stage === 2 ? `<form>${otp}</form>` : stage === 3 ? '<p>Neutral destination</p>' : html;
  return `<!doctype html><html><head><style>${stage === 0 ? css : ''}input,button{min-height:32px}label{display:block;margin:16px}</style></head><body>${body}<script>
    globalThis.identityEvents=0;globalThis.submitEvents=0; let stage=${stage}; const scenario=${JSON.stringify(route)};
    const form=document.querySelector('form');
    if(scenario==='/combined-disabled') form.addEventListener('input',()=>{
      setTimeout(()=>{form.querySelector('button').disabled=[...form.querySelectorAll('input')].some(input=>!input.value)},50);
    });
    if(form) form.addEventListener('submit',event=>{
      event.preventDefault();submitEvents++; stage++;
      if(scenario==='/navigation'||['/password','/otp'].includes(scenario)){location.href=stage===1?'/password':stage===2?'/otp':'/done';return;}
      form.innerHTML=stage===1?${JSON.stringify(password)}:stage===2?${JSON.stringify(otp)}:'<p>Neutral destination</p>';
      if(scenario==='/carry'&&stage===1){form.insertAdjacentHTML('afterbegin',${JSON.stringify(identity)});const input=form.querySelector('input');input.value='synthetic@example.test';input.addEventListener('input',()=>identityEvents++);input.addEventListener('change',()=>identityEvents++);}
    });
  </script></body></html>`;
}
