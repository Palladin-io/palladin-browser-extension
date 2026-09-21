import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';

// Observed HTML/CSS with synthetic values and submit counters, never production
// scripts or authentication. Only current live-login transport is exercised.
// Generic registration/form.submit from the old WIP is explicitly unsupported.
const selected = process.env.PALLADIN_FORM_CORPUS_IDS?.split(',');
const cases = [];
const excluded = [];
for (const group of ['forms', 'non-auth']) {
  for (const entry of await readdir(`tests/fixtures/${group}`, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `tests/fixtures/${group}/${entry.name}`;
    let specimen;
    try { specimen = JSON.parse(await readFile(`${directory}/case.json`, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; excluded.push(directory); continue; }
    if (selected && !selected.includes(specimen.id)) continue;
    cases.push({ specimen, html: await readFile(`${directory}/page.html`, 'utf8'), css: await readFile(`${directory}/page.css`, 'utf8') });
  }
}
assert(cases.length > 0, 'An empty corpus is not a pass');
if (selected) for (const id of selected) assert(cases.some(item => item.specimen.id === id), `Unknown specimen ${id}`);
const replaySource = (await readFile('scripts/replay-form-specimen.mjs', 'utf8')).replaceAll('export function', 'function');
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-corpus-'));
const results = [];
let context;
try {
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: 'https://api.example.test', VITE_POSTHOG_KEY: '' },
    maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route(/^https?:/, route => {
    const url = new URL(route.request().url());
    const item = cases.find(item => url.pathname === `/${item.specimen.id}`);
    if (url.hostname !== 'forms.example.test' || !item) return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${item.css}</style>${item.html}<script>
      ${replaySource}
      hydrateFormSpecimen(document.body, ${JSON.stringify(item.css)});
      installFormActionActivation(document, ${JSON.stringify(item.specimen.actionActivation ?? null)});
      globalThis.querySpecimen = querySpecimen;
      globalThis.corpusClicks = 0;
      const recordedActionSelector = ${JSON.stringify(item.specimen.expected.agent.action ?? null)};
      const recordedAction = recordedActionSelector === null ? null : querySpecimen(document, recordedActionSelector)[0];
      document.addEventListener('submit', event => event.preventDefault());
      document.addEventListener('click', event => {
        const target = event.composedPath()[0];
        const isRecordedAction = recordedActionSelector !== null
          ? recordedAction && event.composedPath().some(node => node === recordedAction)
          : target?.closest?.('button,input[type=submit],input[type=button]');
        if (isRecordedAction) { event.preventDefault(); globalThis.corpusClicks++; }
      });
    </script>` });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  async function binding(url) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await worker.evaluate(async url => {
        for (const tab of await chrome.tabs.query({})) {
          try {
            const current = await chrome.tabs.sendMessage(tab.id, { channel: 'palladin.tab/current-url' }, { frameId: 0 });
            if (current.url === url) return { id: tab.id, ...current };
          } catch { /* Unrelated extension-owned page. */ }
        }
        return null;
      }, url);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Synthetic document binding unavailable');
  }
  const send = (target, message) => worker.evaluate(({ target, message }) => chrome.tabs.sendMessage(target.id, message, { frameId: 0 }), { target, message });
  for (const { specimen } of cases) {
    const row = { id: specimen.id, service: specimen.service, flow: specimen.flow, stage: specimen.stage ?? null, userShield: 'not-run', agentLive: 'not-run' };
    results.push(row);
    try {
      const url = `https://forms.example.test/${specimen.id}`;
      await page.setViewportSize({ width: specimen.source.viewport?.width ?? 1200, height: specimen.source.viewport?.height ?? 900 });
      await page.goto(url);
      const target = await binding(url);
      await page.waitForTimeout(300); // Allow the bounded passive discovery cadence.
      try {
        const launcher = page.locator('palladin-autofill');
        if (specimen.expected.user) await launcher.waitFor({ state: 'attached', timeout: 1500 });
        assert.equal(await launcher.count(), specimen.expected.user ? 1 : 0, 'Unexpected user shield count');
        if (specimen.expected.user) assert.equal(await launcher.evaluate(element => element.shadowRoot), null);
        row.userShield = 'pass';
      } catch (error) { row.userShield = 'fail'; row.userError = error.message.split('\n')[0]; }
      // Registration/profile/SMS-only inspection had a different old WIP executor.
      // Preserve its expected fields in the report; do not count it as live support.
      if (!specimen.expected.user || specimen.flow !== 'login') {
        row.agentLive = 'unsupported-current-adapter';
        row.expectedAgentFieldCount = specimen.expected.agent.fields.length;
        continue;
      }
      const probe = await send(target, { channel: 'palladin.agent-live/probe', documentId: target.documentId, targetUrl: target.url });
      assert.equal(probe.outcome, 'ready', `Current live probe: ${probe.outcome}`);
      const expected = specimen.expected.agent.fields.filter(field => field.fieldId.startsWith('credential.'));
      assert.deepEqual(probe.form.steps[0].fields.map(field => field.entryFieldId).sort(), expected.map(field => field.fieldId).sort(), 'Current live field selection differs from recorded fields');
      const values = expected.map(field => ({ entryFieldId: field.fieldId, value: field.fieldId === 'credential.password'
        ? 'Fixture-only-password!42'.slice(0, specimen.synthetic?.passwordLength) : specimen.synthetic?.username ?? 'fixture-user@example.test' }));
      const before = await page.evaluate(() => querySpecimen(document, 'input,select,textarea').map(field => ({ value: field.value, checked: field.checked })));
      assert.equal(probe.form.version, 2, 'Credential stages require the current deferred contract');
      const ready = await send(target, { channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId: target.documentId,
        expectedDomain: 'forms.example.test', form: probe.form, expiresAt: Date.now() + 10_000, values });
      assert.equal(ready.ok, true, `Deferred fill: ${ready.outcome ?? 'unexpected response'}`);
      const fieldsMatch = await page.evaluate(({ expected, values, before }) => querySpecimen(document, 'input,select,textarea').every((field, index) => {
        const assignment = expected.find(item => querySpecimen(document, item.selector)[0] === field);
        const value = assignment ? values.find(item => item.entryFieldId === assignment.fieldId)?.value : before[index].value;
        return field.value === value && field.checked === before[index].checked;
      }), { expected, values, before });
      assert.equal(fieldsMatch, true, 'Filled or unassigned controls differ');
      assert.equal(await page.evaluate(() => globalThis.corpusClicks), 0, 'Fill must never submit');
      const commit = { channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'forms.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 };
      assert.equal((await send(target, commit)).ok, true, 'Fresh explicit commit rejected');
      assert.equal(await page.evaluate(() => globalThis.corpusClicks), 1, 'Expected one native action');
      assert.equal((await send(target, commit)).ok, false, 'Consumed commit must not replay');
      row.agentLive = 'pass';
    } catch (error) { row.agentLive = 'fail'; row.agentError = error.message.split('\n')[0]; }
    finally { console.log(`${row.id}: user=${row.userShield}, agent=${row.agentLive}`); }
  }
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
  await mkdir('test-results/form-corpus', { recursive: true });
  await writeFile('test-results/form-corpus/report.json', JSON.stringify({
    note: 'Observed specimen structure and recorded viewport (fallback 1200x900) with synthetic behavior. User shield results assert count and a closed shadow root only, not geometry or fill. No production login, native grant authorization or legacy registration executor is proved.',
    excludedDirectoriesWithoutCaseMetadata: excluded, results,
  }, null, 2));
}
if (results.some(row => row.userShield === 'fail' || row.agentLive === 'fail')) process.exitCode = 1;
