import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Actual component/native-dialog acceptance, with synthetic memory-only methods.
const root = process.cwd();
const fixture = await mkdtemp(path.join(root, '.signin-focus-'));
let server, browser;
try {
  await writeFile(path.join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="./main.tsx"></script>');
  await writeFile(path.join(fixture, 'main.tsx'), `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SignInMethodsEditor} from '../src/popup/workspace/SignInMethodField';
import {I18nProvider} from '../src/popup/i18n';
import '../src/popup/popup.css';
import '../src/popup/redesign.css';
function Fixture() {
 const [methods, setMethods] = useState([{id:'synthetic', provider:'google', account:'synthetic@example.test', agentVisible:false}]);
 return <I18nProvider locale="en"><SignInMethodsEditor methods={methods} onSave={async (id, value) => {
  setMethods(current => value ? id ? current.map(method => method.id === id ? {id, ...value} : method) : [...current, {id:'new', ...value}] : current.filter(method => method.id !== id));
 }} /></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({ configFile: false, root, plugins: [react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } }, optimizeDeps: { entries: [path.join(fixture, 'index.html')] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 780, height: 580 } });
  await page.goto(`${server.resolvedUrls.local[0]}${path.basename(fixture)}/index.html`);
  const add = page.getByRole('button', { name: 'Add a sign-in method', exact: true });
  const edit = page.getByRole('button', { name: 'Edit sign-in method', exact: true });
  async function expectFocused(locator, action) {
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.waitForFunction(element => element.isConnected && document.activeElement === element, await locator.elementHandle(), { timeout: 1500 }).catch(() => assert.fail(`${action}: focus did not return to connected trigger`));
  }
  await add.click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectFocused(add, 'Cancel');
  await add.click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expectFocused(add, 'Add Save');
  await edit.first().click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expectFocused(edit.first(), 'Edit Save');
  await edit.first().click();
  await page.getByRole('button', { name: 'Forget sign-in method', exact: true }).click();
  await expectFocused(add, 'Remove');
  console.log('PASS: actual native dialog Cancel, Add Save, Edit Save and Remove restore focus to connected appropriate triggers.');
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
}
