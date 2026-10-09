import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { chromium } from 'playwright';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';

// Real native/extension transports and DOM, synthetic identity and authorization.
// The fixture must be built from the coordinated Agent branch, not an installed CLI.
const binary = process.env.PALLADIN_BROWSER_FIXTURE;
assert.ok(binary && path.isAbsolute(binary), 'Set PALLADIN_BROWSER_FIXTURE to the built browser-fixture example');
const root = await mkdtemp('/tmp/pd-native-');
const sockets = path.join(root, 's');
const contexts = [];
const processes = new Set();
const execute = promisify(execFile);
const html = `<!doctype html><form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button id="submit" type="submit">Sign in</button></form><script>
globalThis.submits=0; document.querySelector('form').addEventListener('submit', e=>{e.preventDefault();globalThis.submits++;e.target.reset();});</script>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  const deadline = Date.now() + 15000;
  do { const value = await fn(); if (value) return value; await delay(50); } while (Date.now() < deadline);
  throw new Error(message);
}
function client(target, { hold = 0, count = 1, session, socketRoot = sockets } = {}) {
  const child = spawn(binary, ['client', socketRoot, String(target.id), target.url, String(hold), String(count), ...(session ? [session] : [])]);
  processes.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { processes.delete(child); resolve({ code, stdout, stderr }); });
  });
  return { child, result, ready: () => until(() => stdout.includes('prepared:ready'), 'Client did not prepare') };
}
async function success(target, options) {
  const result = await client(target, options).result;
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
}
try {
  await mkdir(sockets, { mode: 0o700 });
  const extension = path.join(root, 'dist/chromium');
  await execute(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: 'https://api.example.test', VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(root, 'chromium');
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0,16)].map(byte => (byte >> 4).toString(16) + (byte & 15).toString(16)).join('').replace(/[0-9a-f]/g, hex => String.fromCharCode(97 + parseInt(hex, 16)));
  const shim = path.join(root, 'native-host');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(shim, `#!/bin/sh\nexec ${quote(binary)} host ${quote(sockets)} "$@" 2>>${quote(path.join(root, "host-errors"))}\n`, { mode: 0o700 });
  async function profile(name) {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, 'NativeMessagingHosts'), { recursive: true });
    await writeFile(path.join(directory, 'NativeMessagingHosts/io.palladin.json'), JSON.stringify({ name: 'io.palladin', description: 'Synthetic integration fixture', path: shim, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }));
    const context = await chromium.launchPersistentContext(directory, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    contexts.push(context);
    await context.route(/^https?:/, route => new URL(route.request().url()).hostname === 'login.example.test' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    async function page(suffix) {
      const page = await context.newPage();
      const url = `https://login.example.test/${suffix}`;
      await page.goto(url);
      const target = await until(() => worker.evaluate(async url => {
        for (const tab of await chrome.tabs.query({})) {
          try { const reply = await chrome.tabs.sendMessage(tab.id, { channel: 'palladin.tab/current-url' }, { frameId: 0 });
            if (reply.url === url) return { id: tab.id, url }; } catch { /* No content script. */ }
        }
      }, url), 'Target unavailable');
      return { page, target };
    }
    return { context, worker, page };
  }
  const first = await profile('first');
  const a = await first.page('a');
  await until(async () => (await readdir(sockets)).filter(name => name.endsWith('.sock')).length === 1, 'Native host did not publish a socket');
  await success(a.target, { count: 100 });
  assert.equal(await a.page.evaluate(() => globalThis.submits), 100);
  console.log('PASS 100 sequential operations through native host and built extension');
  const b = await first.page('b');
  await Promise.all([success(a.target), success(b.target)]);
  assert.equal(await b.page.evaluate(() => globalThis.submits), 1);
  console.log('PASS concurrent agents on different tabs');
  const held = client(a.target, { hold: 1000 });
  await held.ready();
  const conflict = await client(a.target).result;
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stdout + conflict.stderr, /busy/i);
  assert.equal((await held.result).code, 0);
  console.log('PASS same-tab reservation rejects second agent');
  const firstSocket = (await readdir(sockets)).find(name => name.endsWith('.sock'));
  const second = await profile('second');
  const c = await second.page('c');
  await until(async () => (await readdir(sockets)).filter(name => name.endsWith('.sock')).length === 2, 'Second host did not publish a socket');
  await Promise.all([success(b.target), success(c.target)]);
  assert.equal(await c.page.evaluate(() => globalThis.submits), 1);
  console.log('PASS automatic exact-target selection across two profiles');
  const secondSocket = (await readdir(sockets)).find(name => name.endsWith('.sock') && name !== firstSocket);
  const secondSession = secondSocket.slice(2, -5);
  const wrongSession = await client(c.target, { session: firstSocket.slice(2, -5) }).result;
  assert.notEqual(wrongSession.code, 0);
  await success(c.target, { session: secondSession });
  assert.equal(await c.page.evaluate(() => globalThis.submits), 2);
  console.log('PASS explicit session never falls back to another profile');
  await first.context.close();
  await success(c.target);
  console.log('PASS closing first profile preserves second connection');
  const cancelled = client(c.target, { hold: 10000 });
  await cancelled.ready();
  cancelled.child.kill();
  await cancelled.result;
  await success(c.target);
  console.log('PASS cancelled preparation releases its own reservation');

  // Forward authenticated bytes, dropping only the third host frame: inject.result.
  // This proxy never decrypts data and never alters a signed/encrypted payload.
  const proxyRoot = path.join(root, 'proxy');
  await mkdir(proxyRoot, { mode: 0o700 });
  let dropped = 0;
  const peers = new Set();
  const server = createServer(downstream => {
    const upstream = createConnection(path.join(sockets, secondSocket));
    peers.add(downstream); peers.add(upstream);
    downstream.pipe(upstream);
    let buffer = Buffer.alloc(0), frames = 0;
    upstream.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = 4 + buffer.readUInt32LE(0);
        const frame = buffer.subarray(0, length); buffer = buffer.subarray(length);
        if (++frames === 3) { dropped++; downstream.destroy(); upstream.destroy(); }
        else downstream.write(frame);
      }
    });
    for (const peer of [downstream, upstream]) {
      peer.on('error', () => { downstream.destroy(); upstream.destroy(); });
      peer.on('close', () => { peers.delete(peer); downstream.destroy(); upstream.destroy(); });
    }
  });
  const proxySocket = path.join(proxyRoot, secondSocket);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(proxySocket, resolve); });
  await chmod(proxySocket, 0o600);
  const before = await c.page.evaluate(() => globalThis.submits);
  try {
    const lost = await client(c.target, { socketRoot: proxyRoot, session: secondSession }).result;
    assert.notEqual(lost.code, 0);
    assert.equal(dropped, 1);
    assert.equal(await c.page.evaluate(() => globalThis.submits), before + 1);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  await success(c.target);
  assert.equal(await c.page.evaluate(() => globalThis.submits), before + 2);
  console.log('PASS lost authenticated response never replays submit; next operation works');

  await second.context.close();
  const restarted = await profile('second');
  const d = await restarted.page('after-restart');
  await success(d.target);
  const currentSocket = (await readdir(sockets)).find(name => name.endsWith('.sock'));
  assert.notEqual(currentSocket, secondSocket);
  console.log('PASS profile restart publishes a fresh connection and restores operation');
  console.log('Waiting 305 seconds to cross the former native-host idle limit');
  await delay(305000);
  await success(d.target);
  assert.equal(await d.page.evaluate(() => globalThis.submits), 2);
  assert.deepEqual((await readdir(sockets)).filter(name => name.endsWith('.sock')), [currentSocket]);
  console.log('PASS idle beyond five minutes retains the same authenticated host connection');
} finally {
  for (const child of processes) child.kill();
  await Promise.allSettled(contexts.map(context => context.close()));
  console.log('fixture host errors', await readFile(path.join(root, 'host-errors'), 'utf8').catch(() => 'none'));
  await rm(root, { recursive: true, force: true });
}
