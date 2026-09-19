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
    return url.hostname === 'login.example.test' ? route.fulfill({ contentType: 'text/html', body: fixture(url.pathname) }) : route.abort();
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
  for (const scenario of ['aws-spa', 'combined', 'carry', 'navigation']) {
    await page.goto(`https://login.example.test/${scenario}`);
    const stages = scenario === 'combined' ? [['credential.username', 'credential.password'], ['credential.totp']]
      : [['credential.username'], scenario === 'carry' ? ['credential.username', 'credential.password'] : ['credential.password'], ['credential.totp']];
    for (const fields of stages) {
      const target = await binding();
      const probe = await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url });
      assert.equal(probe.outcome, 'ready');
      assert.deepEqual(probe.form.steps[0].fields.map(field => field.entryFieldId), fields);
      const message = { channel: 'palladin.agent-inject/step', documentId: target.documentId, expectedDomain: 'login.example.test', step: probe.form.steps[0],
        values: fields.map(entryFieldId => ({ entryFieldId, value: entryFieldId === 'credential.username' ? 'synthetic@example.test' : entryFieldId === 'credential.password' ? 'Synthetic-password!42' : '123456' })) };
      assert.deepEqual(await send(target, message), { ok: true });
      if (scenario === 'navigation') {
        const nextPath = fields.includes('credential.username') ? '/password' : fields.includes('credential.password') ? '/otp' : '/done';
        await page.waitForURL(url => url.pathname === nextPath, { waitUntil: 'domcontentloaded' });
      }
      assert.equal((await send(await binding(), message)).ok, false, 'A consumed or old-document step cannot repeat');
    }
    const target = await binding();
    assert.deepEqual(await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url }), { outcome: 'no-form' });
    if (scenario === 'carry') assert.equal(await page.evaluate(() => globalThis.identityEvents), 0);
    await page.evaluate(() => { document.body.innerHTML = '<div data-sitekey="synthetic" style="width:200px;height:100px">Security check</div>'; });
    assert.deepEqual(await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url }), { outcome: 'challenge' });
    console.log(`PASS ${scenario}: fresh bound stages, replay denial, no-form and challenge`);
  }
} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }

function fixture(route) {
  const password = '<label>Password<input type="password" autocomplete="current-password"></label><button>Sign in</button>';
  const identity = '<label>Email<input autocomplete="username" type="email"></label>';
  const otp = '<label>Authenticator code<input autocomplete="one-time-code"></label><button>Verify</button>';
  const stage = route === '/password' ? 1 : route === '/otp' ? 2 : route === '/done' ? 3 : route === '/combined' ? 1 : 0;
  const body = route === '/combined' ? `<form>${identity}${password}</form>` : stage === 1 ? `<form>${password}</form>`
    : stage === 2 ? `<form>${otp}</form>` : stage === 3 ? '<p>Neutral destination</p>' : html;
  return `<!doctype html><html><head><style>${stage === 0 ? css : ''}input,button{min-height:32px}label{display:block;margin:16px}</style></head><body>${body}<script>
    globalThis.identityEvents=0; let stage=${stage}; const scenario=${JSON.stringify(route)};
    const form=document.querySelector('form');
    if(form) form.addEventListener('submit',event=>{
      event.preventDefault(); stage++;
      if(scenario==='/navigation'||['/password','/otp'].includes(scenario)){location.href=stage===1?'/password':stage===2?'/otp':'/done';return;}
      form.innerHTML=stage===1?${JSON.stringify(password)}:stage===2?${JSON.stringify(otp)}:'<p>Neutral destination</p>';
      if(scenario==='/carry'&&stage===1){form.insertAdjacentHTML('afterbegin',${JSON.stringify(identity)});const input=form.querySelector('input');input.value='synthetic@example.test';input.addEventListener('input',()=>identityEvents++);input.addEventListener('change',()=>identityEvents++);}
    });
  </script></body></html>`;
}
