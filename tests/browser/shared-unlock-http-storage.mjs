import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const webSource = process.argv[process.argv.indexOf('--web-source') + 1]
if (!process.argv.includes('--web-source') || !webSource) throw new Error('--web-source is required')
const source = path.resolve(webSource, 'src/features/auth/shared-unlock')
const entry = `
import { SharedUnlockLinkStore } from ${JSON.stringify(path.join(source, 'link-store.ts'))};
import { SharedUnlockPreferenceGate } from ${JSON.stringify(path.join(source, 'preference-gate.ts'))};
import { SharedUnlockExpiryStore } from ${JSON.stringify(path.join(source, 'expiry-store.ts'))};
import { withSharedUnlockStorageLock, withSharedUnlockPublicationLocks } from ${JSON.stringify(path.join(source, 'storage-lock.ts'))};
let stall = false, resume, readEntered = false, publications = 0;
const storage = {
 get: async keys => {
   const result = Object.fromEntries(keys.filter(key => localStorage.getItem(key) !== null).map(key => [key, JSON.parse(localStorage.getItem(key))]));
   if (stall) { stall = false; readEntered = true; await new Promise(resolve => { resume = resolve; }); }
   return result;
 },
 set: async items => { for (const [key, value] of Object.entries(items)) localStorage.setItem(key, JSON.stringify(value)); },
};
const gate = new SharedUnlockPreferenceGate(storage, action => withSharedUnlockStorageLock('pause', action));
const links = new SharedUnlockLinkStore(storage);
const expiry = new SharedUnlockExpiryStore(storage, undefined, () => 100);
const scope = accountId => ({ apiUrl: 'http://api.example.test', webOrigin: location.origin, extensionId: 'synthetic-test', accountId });
window.storageTest = {
 ensure: id => links.ensure(scope(id)).then(value => value.linkId),
 pause: id => gate.pause(scope(id)).persisted,
 close: (id, action) => links.recordManualClosing(scope(id), action),
 retire: id => expiry.advance(scope(id), 5),
 checkpoint: id => expiry.checkpoint(scope(id), 5, 200, 900),
 stall: () => { stall = true; readEntered = false; },
 readEntered: () => readEntered,
 resume: () => resume(),
 publications: () => publications,
 publish: async (id, linkId) => {
  try {
   return await withSharedUnlockPublicationLocks(lease => gate.withAllowed(scope(id), () =>
    links.withInstallable(scope(id), linkId, 2, 5, () =>
     expiry.withCheckpoint(scope(id), 5, 500, 900, deadline => {
      gate.assertAllowed(scope(id)); publications++; return { ok: true, deadline };
     }, lease), lease), lease));
  } catch { return { ok: false }; }
 },
};`
const bundled = await build({ stdin: { contents: entry, resolveDir: source, loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser' })
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/test.js' ? 'text/javascript' : 'text/html')
  response.end(request.url === '/test.js' ? bundled.outputFiles[0].contents : '<!doctype html><title>HTTP storage boundary test</title><script src="/test.js"></script>')
})
let browser
const checks = []
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://panel.palladin.test:${server.address().port}`
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP panel.palladin.test 127.0.0.1', '--no-proxy-server'] })
  const context = await browser.newContext()
  const a = await context.newPage(), b = await context.newPage()
  await Promise.all([a.goto(origin), b.goto(origin)])
  assert.deepEqual(await a.evaluate(() => ({ secure: isSecureContext, subtle: !!crypto.subtle, locks: !!navigator.locks })), { secure: false, subtle: false, locks: false })
  checks.push('real-insecure-http-without-subtlecrypto-or-web-locks')
  const account = index => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
  const ensure = (page, id) => page.evaluate(id => window.storageTest.ensure(id), id)
  const publish = (page, id, linkId) => page.evaluate(({ id, linkId }) => window.storageTest.publish(id, linkId), { id, linkId })
  const [linkA, linkB] = await Promise.all([ensure(a, account(1)), ensure(b, account(1))])
  assert.equal(linkA, linkB)
  checks.push('two-documents-allocate-one-durable-link')
  await b.evaluate(id => window.storageTest.checkpoint(id), account(1))
  assert.deepEqual(await publish(a, account(1), linkA), { ok: true, deadline: 200 })
  checks.push('publication-holds-all-scopes-and-retains-peer-deadline')
  for (const [index, denial] of ['pause', 'lock', 'logout', 'expiry'].entries()) {
    const id = account(index + 2), linkId = await ensure(a, id)
    await b.evaluate(async ({ id, denial }) => {
      if (denial === 'pause') await window.storageTest.pause(id)
      else if (denial === 'expiry') await window.storageTest.retire(id)
      else await window.storageTest.close(id, denial)
    }, { id, denial })
    assert.deepEqual(await publish(a, id, linkId), { ok: false })
    checks.push(`committed-peer-${denial}-prevents-publication`)
  }
  const id = account(6), linkId = await ensure(a, id)
  await a.evaluate(() => window.storageTest.stall())
  const delayed = publish(a, id, linkId)
  await a.waitForFunction(() => window.storageTest.readEntered())
  assert.deepEqual(await delayed, { ok: false })
  await b.evaluate(id => window.storageTest.pause(id), id)
  await a.evaluate(() => window.storageTest.resume())
  assert.deepEqual(await publish(a, id, linkId), { ok: false })
  assert.equal(await a.evaluate(() => window.storageTest.publications()), 1)
  checks.push('lost-transaction-releases-peer-writer-and-fences-late-read')
  const output = path.resolve('test-results/shared-unlock-http-storage')
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ scope: 'native-chromium-http-storage-boundary', browser: browser.version(), containsUserData: false, observedAt: new Date().toISOString(), checks }, null, 2) + '\n')
  console.log(`PASS: ${checks.length} native HTTP storage checks; no full Identity handoff claimed.`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
