// Trusted-event observer replay. Production HTML is observed; all values and
// event handlers/transitions are synthetic. This does not test worker encryption.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = process.cwd();
const bundled = await build({ stdin: { contents: `import {CredentialSubmissionObserver} from './src/content/isolated/credential-submission'; import {markAgentManagedControl} from './src/content/isolated/agent-managed-controls'; window.captured=[]; window.markAgentManagedControl=markAgentManagedControl; new CredentialSubmissionObserver(document,'synthetic-document',c=>window.captured.push(c)).start();`, resolveDir: root }, bundle: true, write: false, format: 'iife', alias: { '@shared': resolve(root, 'src/shared') } });
const browser = await chromium.launch({ headless: true });
let passed = 0;
async function specimen(html, operation, expected = 1, setup) {
  const page = await browser.newPage({ viewport: { width: 1146, height: 483 } });
  page.setDefaultTimeout(5000);
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8">' + html }));
    await page.goto('https://capture.example.test/login');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    if (setup) await setup(page);
    await page.evaluate(() => {
      document.addEventListener('submit', event => event.preventDefault());
      for (const field of document.querySelectorAll('input')) {
        if (field.type === 'password') field.value = 'Synthetic-password42';
        else if (['text', 'email'].includes(field.type)) field.value = 'synthetic@example.test';
      }
    });
    await operation(page);
    const count = await page.evaluate(() => window.captured.filter(command => command.type === 'submitted').length);
    assert.equal(count, expected);
    passed++;
  } finally { await page.close(); }
}
const controls = '<input autocomplete="username"><input type="password" autocomplete="current-password"><button type="button">Sign in</button>';
try {
  await specimen(`<div>${controls}</div>`, page => page.getByRole('button').click());
  await specimen(`<div>${controls}</div>`, async page => { await page.locator('[type=password]').press('Enter'); });
  await specimen(`<form>${controls.replace('type="button"', 'type="submit"')}</form>`, page => page.getByRole('button').click()); // click + native submit deduplicate
  await specimen(`<form>${controls}</form>`, page => page.getByRole('button').evaluate(button => button.click()), 0);
  await specimen(`<form>${controls}</form>`, page => page.locator('[type=password]').dispatchEvent('keydown', { key: 'Enter' }), 0);
  await specimen(`<form action="https://other.example.test/">${controls}</form>`, page => page.getByRole('button').click(), 0);
  await specimen(`<form>${controls.replace('type="button"', 'type="submit" formaction="https://other.example.test/"')}</form>`, page => page.getByRole('button').click(), 0);
  await specimen(`<form>${controls.replace('type="button"', 'type="submit" formaction="https://other.example.test/"')}</form>`, page => page.locator('[type=password]').press('Enter'), 0);
  await specimen(`<div>${controls}</div>`, page => page.getByRole('button').click(), 0, page => page.evaluate(() => document.querySelectorAll('input').forEach(window.markAgentManagedControl)));
  await specimen('<form><public-fields></public-fields></form>', page => page.getByRole('button').click(), 1, async page => {
    await page.evaluate(markup => { const shadow = document.querySelector('public-fields').attachShadow({ mode: 'open' }); shadow.innerHTML = markup; shadow.querySelectorAll('input').forEach(field => { field.value = 'synthetic'; }); }, controls);
  });
  const path = 'tests/fixtures/forms/linkedin-capture-2026-09-15/';
  const [html, css] = await Promise.all([readFile(path + 'page.html', 'utf8'), readFile(path + 'page.css', 'utf8')]);
  await specimen(`<style>${css}</style>${html}`, page => page.locator('[data-form-specimen-node="202"]').click());
  console.log(JSON.stringify({ passed, trustedEventReplay: true, productionAuthentication: 'not-tested' }));
} finally { await browser.close(); }
