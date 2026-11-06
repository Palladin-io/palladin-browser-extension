import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createCaptureApi, allowCaptureApi } from './capture-api.mjs';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';
import { openNativePopup } from './native-popup.mjs';
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs';

const api = await createCaptureApi();
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-generator-'));
let context;
let popup;
try {
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_POSTHOG_KEY: '' },
    maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium');
  await allowCaptureApi(extension, api.url);
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1200, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  context = await launch();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const onboarding = context.pages().find(page => page.url().includes('/onboarding/'));
  if (onboarding) await onboarding.close();
  popup = await openNativePopup(worker, profile, extensionId);
  await popup.click('Continue to Palladin');
  await popup.waitButton('Sign in');
  assert.equal((await popup.configureConnection({ name: 'Synthetic capture API', apiUrl: api.url,
    webUrl: api.url, allowHttp: true, sharedUnlockEnabled: false })).ok, true);

  await popup.fill('input[type=email]', api.email);
  await popup.fill('input[type=password]', api.password);
  await popup.click('Sign in');
  await popup.waitText('No entries yet.');
  await context.route('https://register.example.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <style>body{margin:80px;font:16px system-ui}input{display:block;padding:12px;margin:16px;width:320px}button{margin-top:180px}</style>
    <form><label>Email<input autocomplete="username" name="username"></label>
    <label>New password<input type="password" autocomplete="new-password" name="password"></label>
    <label>Confirm password<input type="password" autocomplete="new-password" name="confirm"></label>
    <button>Register</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('form').outerHTML='<p role="status">Account created</p>'}</script>` }));
  const page = await context.newPage();
  await page.goto('https://register.example.test/signup');
  await page.getByLabel('Email', { exact: true }).fill('synthetic-user');
  await page.getByLabel('New password', { exact: true }).click();
  const cdp = await context.newCDPSession(page);
  const clickSurfaceButton = async (name, role = 'button') => {
    const deadline = Date.now() + 10000;
    let button;
    while (!button && Date.now() < deadline) {
      button = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(node =>
        !node.ignored && node.role?.value === role && node.name?.value === name);
      if (!button) await page.waitForTimeout(100);
    }
    assert(button, `Inline action is accessible: ${name}`);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: button.backendDOMNodeId });
    await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
    if (role === 'option') await waitPreview();
  };
  const inspect = async () => {
    const tree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = node => {
      const attrs = node.attributes ?? [];
      if (attrs.some((value, index) => index % 2 === 0 && value === 'class' && attrs[index + 1].split(' ').includes('generator-panel'))) return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) { const found = find(child); if (found) return found; }
    };
    const panel = find(tree.root); if (!panel) return null;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: panel.nodeId });
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function() {
      const style = getComputedStyle(this), heading = getComputedStyle(this.querySelector('.generator-heading'));
      const options = this.querySelector('.generator-options'), footer = this.querySelector('.generator-footer');
      return { value: this.querySelector('code').textContent, width: this.getBoundingClientRect().width, top: this.getBoundingClientRect().top,
        hidden: this.hidden, radius: style.borderRadius, headingFont: heading.fontSize, headingWeight: heading.fontWeight,
        lineHeight: style.lineHeight, regenerateHeight: this.querySelector('.generator-value button').getBoundingClientRect().height,
        regenerateWeight: getComputedStyle(this.querySelector('.generator-value button')).fontWeight,
        chevrons: [...this.querySelectorAll('[role=combobox] svg')].map(svg => svg.getBoundingClientRect().width),
        menus: [...this.getRootNode().querySelectorAll('[role=listbox]')].filter(menu => !menu.hidden).map(menu => ({ label: menu.getAttribute('aria-label'), height: menu.getBoundingClientRect().height, top: menu.getBoundingClientRect().top, bottom: menu.getBoundingClientRect().bottom, outsideClip: !menu.closest('.generator-options-clip') })),
        transition: getComputedStyle(options).transitionDuration, optionsOpen: !options.inert,
        buttons: [...footer.querySelectorAll('button')].map(button => ({ text: button.textContent, width: button.getBoundingClientRect().width, disabled: button.disabled })),
        length: this.querySelector('input[type=range]')?.value, lengthOutputGap: this.querySelector('output') ? this.querySelector('input[type=range]').getBoundingClientRect().right - this.querySelector('output').getBoundingClientRect().right : null, options: [...this.querySelectorAll('[role=combobox]')].map(button => button.textContent),
        inputCount: this.querySelectorAll('input[type=text],input[type=password],textarea').length };
    }` });
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
    return result.result.value;
  };
  const waitPreview = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const current = await inspect(); if (current?.value && !current.buttons[1].disabled) return current; await page.waitForTimeout(50); }
    throw Error('Generated preview was not ready');
  };
  await mkdir('test-results/generator', { recursive: true });
  if (!process.env.PALLADIN_VISUAL_ONLY) {
  let visible = await waitPreview();
  const fieldBox = await page.getByLabel('New password', { exact: true }).boundingBox();
  assert.equal(visible.width, fieldBox.width, 'Suggestion follows the field width');
  assert.equal(visible.top, fieldBox.y + fieldBox.height - 4, 'Approved attached placement');
  assert.equal(visible.lineHeight, '24px'); assert.equal(visible.regenerateHeight, 36); assert.equal(visible.regenerateWeight, '600');
  assert.equal(visible.radius, '8px'); assert.equal(visible.headingFont, '12px'); assert.equal(visible.headingWeight, '400');
  assert.deepEqual(visible.buttons.map(button => button.text), ['Dismiss', 'Use password']);
  assert.equal(visible.buttons[0].width, visible.buttons[1].width); assert.equal(visible.inputCount, 0);
  assert.equal(await page.locator('palladin-autofill').first().evaluate(host => host.shadowRoot), null);
  await page.screenshot({ path: 'test-results/generator/collapsed-light.png' });
  const firstPreview = visible.value;
  await clickSurfaceButton('Generate another password');
  visible = await waitPreview(); assert(visible.value !== firstPreview, 'Regenerate replaces the preview');
  assert.equal(await page.locator('[name=password]').inputValue(), '', 'Regenerate does not fill the site');
  await clickSurfaceButton('Password options'); await page.waitForTimeout(300);
  assert.equal((await inspect()).transition, '0.24s, 0.18s');
  const slider = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(node => !node.ignored && node.role?.value === 'slider' && node.name?.value === 'Length');
  assert(slider); const sliderBox = (await cdp.send('DOM.getBoxModel', { backendNodeId: slider.backendDOMNodeId })).model;
  await page.mouse.click((sliderBox.content[0] + sliderBox.content[4]) / 2, (sliderBox.content[1] + sliderBox.content[5]) / 2);
  await page.keyboard.press('Home'); for (let index = 0; index < 9; index++) await page.keyboard.press('ArrowRight');
  await clickSurfaceButton('Numbers', 'checkbox'); await clickSurfaceButton('Symbols', 'checkbox');
  visible = await waitPreview(); assert.equal(visible.length, '21');
  await page.screenshot({ path: 'test-results/generator/password-options-light.png' });
  await clickSurfaceButton('Type', 'combobox'); await clickSurfaceButton('Passphrase', 'option');
  await clickSurfaceButton('Words', 'combobox');
  let menuState = (await inspect()).menus;
  assert.equal(menuState[0].label, 'Words'); assert.equal(menuState[0].outsideClip, true);
  assert(menuState[0].height >= 144 && menuState[0].top >= 0 && menuState[0].bottom <= 850, 'All four word-count options fit without clipping');
  await page.screenshot({ path: 'test-results/generator/words-menu-light.png' });
  await clickSurfaceButton('3', 'option'); assert.equal((await inspect()).options[1], '3');
  await clickSurfaceButton('Words', 'combobox'); await clickSurfaceButton('6', 'option');
  await clickSurfaceButton('Separator', 'combobox'); await clickSurfaceButton('Dot', 'option');
  await clickSurfaceButton('Words', 'combobox'); await clickSurfaceButton('Type', 'combobox');
  assert.deepEqual((await inspect()).menus.map(menu => menu.label), ['Type']);
  await clickSurfaceButton('Password', 'option');
  visible = await waitPreview(); assert.equal(visible.length, '21');
  assert.deepEqual(visible.chevrons, [16]);
  const previewToUse = visible.value;
  await clickSurfaceButton('Use password');
  await page.waitForFunction(() => document.querySelector('[name=password]').value.length === 21);
  const generated = await page.locator('[name=password]').inputValue();
  assert(/^[A-Za-z]{21}$/.test(generated), 'Requested password options');
  assert(generated === previewToUse, 'Use fills the exact displayed preview');
  assert(await page.locator('[name=confirm]').inputValue() === generated, 'Matching confirmation field');
  assert.equal(api.writes.length, 0, 'Generation must not create a Vault entry');
  const stored = await worker.evaluate(() => chrome.storage.local.get(null));
  const historyKeys = Object.keys(stored).filter(key => key.startsWith('palladin.generator-history.v1:'));
  assert.equal(historyKeys.length, 0);
  assert(!JSON.stringify(stored).includes(generated), 'Persistent storage must contain no generated plaintext');
  console.log('PASS: trusted inline action fills both fields without local password history');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Account created' }).waitFor();
  popup.close();
  popup = await openNativePopup(worker, profile, extensionId);
  assert(!(await popup.hasText('Password history')), 'No standalone password history tab');
  popup.close(); popup = undefined;
  await page.goto('https://register.example.test/signup?mode=passphrase');
  await page.getByLabel('New password', { exact: true }).click();
  await waitPreview();
  await clickSurfaceButton('Password options'); await page.waitForTimeout(300);
  await clickSurfaceButton('Type', 'combobox');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await clickSurfaceButton('Separator', 'combobox'); await clickSurfaceButton('Dot', 'option');
  visible = await waitPreview(); assert.deepEqual(visible.options, ['Passphrase', '4', 'Dot']);
  await clickSurfaceButton('Words', 'combobox'); await clickSurfaceButton('6', 'option');
  await clickSurfaceButton('Type', 'combobox'); await clickSurfaceButton('Password', 'option'); await waitPreview();
  await clickSurfaceButton('Type', 'combobox'); await clickSurfaceButton('Passphrase', 'option');
  visible = await waitPreview(); assert.deepEqual(visible.options, ['Passphrase', '6', 'Dot']);
  assert.deepEqual(visible.chevrons, [16, 16, 16]);
  await clickSurfaceButton('Words', 'combobox');
  await page.mouse.click(fieldBox.x - 20, fieldBox.y);
  assert.deepEqual((await inspect()).menus, []);
  const phraseToUse = visible.value;
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  assert.equal((await inspect()).transition, '0s');
  await page.screenshot({ path: 'test-results/generator/passphrase-options-dark-reduced.png' });
  await clickSurfaceButton('Use password');
  await page.waitForFunction(() => document.querySelector('[name=password]').value.split('.').length === 6);
  const phrase = await page.locator('[name=password]').inputValue();
  assert(/^[a-z]+(?:\.[a-z]+){5}$/.test(phrase), 'Requested passphrase options');
  assert(phrase === phraseToUse, 'Passphrase Use fills the displayed preview');
  assert(await page.locator('[name=confirm]').inputValue() === phrase, 'Matching passphrase confirmation');
  const afterPhrase = await worker.evaluate(() => chrome.storage.local.get(null));
  assert(!JSON.stringify(afterPhrase).includes(phrase), 'Passphrase must not persist as plaintext');
  assert.equal(api.writes.length, 0, 'Options and fill must not create a Vault entry');
  console.log('PASS: approved generator shell/options, exact preview fill, reduced motion and no persistence');
  await page.goto('https://register.example.test/signup?dismiss');
  await page.getByLabel('New password', { exact: true }).click(); await waitPreview();
  await clickSurfaceButton('Dismiss'); assert.equal((await inspect()).hidden, true);
  assert.equal(await page.locator('[name=password]').inputValue(), '');
  await clickSurfaceButton('Suggest a strong password'); await waitPreview();
  await clickSurfaceButton('Dismiss password suggestion'); assert.equal((await inspect()).hidden, true);
  console.log('PASS: both dismiss controls close without fill and the real shield reopens suggestions');
  }
  const polish=JSON.parse(await readFile('src/popup/locales/pl.json','utf8'));
  for (const theme of ['light','dark']) {
    await worker.evaluate(preferences=>chrome.storage.local.set({'palladin.ui.preferences':preferences}),{language:'pl',theme});
    await page.goto(`https://register.example.test/signup?visual=pl-${theme}`);
    await page.getByLabel('New password',{exact:true}).click(); await waitPreview();
    await page.screenshot({path:`test-results/generator/pl-${theme}-collapsed.png`});
    await clickSurfaceButton(polish['generator.inlineOptions']); await page.waitForTimeout(300);
    assert.equal((await inspect()).lengthOutputGap,0,'Length count aligns to caption right edge as approved prototype');
    await page.screenshot({path:`test-results/generator/pl-${theme}-password-options.png`});
    await clickSurfaceButton(polish['generator.inlineType'],'combobox');
    await clickSurfaceButton(polish['generator.passphrase'],'option');
    await clickSurfaceButton(polish['generator.words'],'combobox');
    await page.screenshot({path:`test-results/generator/pl-${theme}-words-menu.png`});
    await clickSurfaceButton('3','option');
    const preview=await waitPreview();
    await page.screenshot({path:`test-results/generator/pl-${theme}-passphrase-options.png`});
    assert.equal(preview.options[1],'3');
    await clickSurfaceButton(polish['generator.inlineUse']);
    await page.waitForFunction(()=>document.querySelector('[name=password]').value.length>0);
    assert(await page.locator('[name=password]').inputValue()===preview.value,'Localized Use fills exact preview');
  }
  console.log('PASS: Polish generator collapsed/password/passphrase/menu in light and dark, exact preview fill');

} finally {
  popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true });
}
