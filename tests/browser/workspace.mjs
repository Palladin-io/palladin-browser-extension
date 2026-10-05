import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createCaptureApi } from './capture-api.mjs';
import { openNativePopup } from './native-popup.mjs';
import { cacheBustContentLoaders } from '../../scripts/cache-bust-content-loaders.mjs';
import { validateBuiltManifest } from '../../scripts/validate-built-manifest.mjs';

const shares = new Map();
const grants = [];
const api = await createCaptureApi({ workspaceHandler: async ({ method, url, request, vaults, userId, send }) => {
  if (url.pathname === '/api/account/shared-unlock') { send({ sharedUnlockEnabled: false, revision: 1 }); return true; }
  if (url.pathname === '/api/organization/member-directory') { send({ items: [{ userId, displayName: 'Synthetic owner' }] }); return true; }
  if (url.pathname === '/api/audit-logs') { send({ items: [{ id: randomUUID(), eventType: 'entry.created', actorType: 'user', userId, vaultId: vaults[0].detail.id, entryId: [...vaults[0].entries.keys()][0] ?? null, metadata: {}, createdAt: new Date().toISOString() }], nextCursor: null }); return true; }
  if (url.pathname === '/api/grants/summary') { send({ pending: grants.filter(g => g.status === 'pending').length, active: grants.filter(g => g.status === 'active').length, expired: 0, revoked: 0, consumed: 0, denied: 0 }); return true; }
  if (url.pathname === '/api/grants') { send({ items: grants.filter(g => !url.searchParams.get('status') || g.status === url.searchParams.get('status')), nextCursor: null }); return true; }
  if (url.pathname === '/api/entry-sharing') { send({ items: [...shares.values()].map(({ nonce, ciphertext, accessToken, protectionSecret, vaultId, entryId, ...share }) => ({ vaultId, entryId, share })), nextCursor: null }); return true; }
  const match = /^\/api\/vaults\/([^/]+)\/entries\/([^/]+)\/sharing(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return false;
  const entry = vaults.find(vault => vault.detail.id === match[1])?.entries.get(match[2]);
  if (!entry) { send(null, 404); return true; }
  if (method === 'POST' && match[3] === 'creation-challenge') { send({ shareId: randomUUID(), sourceRevision: entry.currentRevision, expiresAt: new Date(Date.now() + 60_000).toISOString() }); return true; }
  if (method === 'POST') {
    assert.equal(request.sourceRevision, entry.currentRevision);
    assert(!JSON.stringify(request).includes('Synthetic entry password'));
    assert(!('key' in request));
    shares.set(request.shareId, { ...request, vaultId: match[1], entryId: match[2], status: 'active', createdAt: new Date().toISOString(), deliveryCount: 0, firstDeliveredAt: null, lastDeliveredAt: null, firstConfirmedAt: null, sourceChanged: false });
    send(null); return true;
  }
  if (method === 'GET') { send({ items: [...shares.values()].map(({ nonce, ciphertext, accessToken, protectionSecret, ...item }) => item), nextCursor: null }); return true; }
  if (method === 'DELETE') { shares.get(match[3]).status = 'revoked'; send(null); return true; }
  send(null, 404); return true;
} });
const profile = await mkdtemp(path.join(tmpdir(), 'palladin-workspace-'));
const output = path.resolve('test-results/workspace');
await mkdir(output, { recursive: true });
let context, popup;
try {
  const extension = path.join(profile, 'dist/chromium');
  await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', extension], {
    env: { ...process.env, PALLADIN_TARGET: 'chromium', PALLADIN_CHANNEL: 'production', VITE_API_URL: api.url, VITE_WEB_APP_URL: 'https://web.example.test', VITE_POSTHOG_KEY: '' }, maxBuffer: 4 * 1024 * 1024,
  });
  cacheBustContentLoaders(profile, 'chromium'); validateBuiltManifest(profile, 'chromium');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 850 }, args: ['--window-size=1280,900', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const onboarding = context.pages().find(page => page.url().includes('/onboarding/')); if (onboarding) await onboarding.close();
  await worker.evaluate(() => chrome.storage.local.set({ 'palladin.ui.preferences': { language: 'en', theme: 'light' } }));
  popup = await openNativePopup(worker, profile, extensionId);
  await popup.waitButton('Continue to Palladin');
  await popup.screenshot(path.join(output, 'intro-light.png'));
  assert((await popup.viewportSize()).width <= 440, 'Onboarding should use the compact popup');
  await popup.click('Continue to Palladin');
  await popup.waitButton('Sign in');
  const brand = await popup.brandTypography();
  assert(brand.family.startsWith('Inter') && brand.loaded, 'Auth wordmark must render the bundled web Inter font');
  assert.equal(brand.weight, '800');
  assert.equal(brand.size, '19px');
  assert.equal(brand.spacing, '-0.19px');
  await popup.waitHeight(350, 370);
  assert((await popup.viewportSize()).height <= 370, 'Sign-in must not reserve workspace height');
  await popup.screenshot(path.join(output, 'sign-in-light.png'));
  await popup.fill('input[type=email]', api.email); await popup.fill('input[type=password]', api.password); await popup.click('Sign in');
  await popup.waitText('No entries yet.');
  await popup.waitWidth(780, 800);
  assert((await popup.viewportSize()).width >= 780, 'Unlock must expand the existing native popup');
  await popup.click('Add entry');
  await popup.fill('.entry-form input[autocomplete=off]', 'Synthetic account');
  await popup.fill('.entry-form input[autocomplete=username]', 'synthetic@example.test');
  await popup.fill('.entry-form input[type=password]', 'Synthetic entry password');
  await popup.fill('.entry-form input[type=url]', 'https://app.example.test');
  await popup.click('Save entry'); await popup.waitText('Entry saved securely');
  await popup.click('Vault', 'tab');
  await popup.screenshot(path.join(output, 'list.png'));
  await popup.click('Synthetic account app.example.test · Vault: Personal');
  await popup.waitText('synthetic@example.test');
  await popup.screenshot(path.join(output, 'entry-light.png'));
  await popup.click('Share');
  await popup.screenshot(path.join(output, 'share-form-light.png'));
  await popup.click('Create link');
  await popup.waitText('Save this link now.');
  assert.equal(shares.size, 1, 'The real popup must produce one encrypted share');
  await popup.screenshot(path.join(output, 'share-light.png'));
  await popup.click('Sharing', 'tab');
  await popup.click('Synthetic account · Personal');
  await popup.click('Revoke');
  assert.equal([...shares.values()][0].status, 'revoked');
  await popup.click('Logs', 'tab'); await popup.waitText('Synthetic owner');
  await popup.screenshot(path.join(output, 'logs-light.png'));
  grants.push({ id: randomUUID(), vaultId: api.vaults[0].detail.id, agentId: randomUUID(), agentName: 'Synthetic active agent', createdBy: api.userId ?? '11111111-1111-4111-8111-111111111111', createdByName: 'Synthetic owner', grantedAt: new Date().toISOString(), entryId: [...api.vaults[0].entries.keys()][0], status: 'active', type: 'granular', createdAt: new Date().toISOString(), entryScopes: [], scriptScopes: [], canRevoke: true });
  await popup.click('Agent access', 'tab'); await popup.waitText('Synthetic active agent');
  await popup.click(/^Synthetic active agent Active/);
  await popup.waitText('Granted by');
  await popup.screenshot(path.join(output, 'grant-detail-light.png'));
  grants.push({ id: randomUUID(), vaultId: api.vaults[0].detail.id, agentId: randomUUID(), agentName: 'Synthetic pending agent', status: 'pending', type: 'granular', createdAt: new Date().toISOString(), entryScopes: [], scriptScopes: [] });
  await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'workspace/changed' }));
  await popup.waitText('Synthetic pending agent');
  for (let index = 0; index < 18; index++) grants.push({ ...grants[0], id: randomUUID(), agentName: `Synthetic scroll agent ${index}` });
  await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'workspace/changed' }));
  await popup.waitText('Synthetic scroll agent 17');
  assert.deepEqual(await popup.grantScrollLayout(), { listScrolls: true, panelFits: true, contentFits: true, headingStable: true });
  await popup.screenshot(path.join(output, 'grants-scroll-light.png'));
  const workspaceSize = await popup.viewportSize();
  await popup.click('Generator');
  await popup.waitText('Length');
  assert(!await popup.hasText('Back'), 'Generator does not need a back row');
  await popup.screenshot(path.join(output, 'generator-light.png'));
  await popup.click('Settings', 'tab');
  await popup.waitText('Appearance');
  assert.deepEqual(await popup.viewportSize(), workspaceSize, 'Settings must preserve the unlocked popup dimensions');
  await popup.screenshot(path.join(output, 'settings-unlocked.png'));
  await popup.click('Save and update logins');
  await popup.waitText('Automatic password updates');
  assert.deepEqual(await popup.viewportSize(), workspaceSize, 'Capture settings must preserve workspace dimensions');
  await popup.screenshot(path.join(output, 'settings-capture.png'));
  await popup.click('Appearance');
  await popup.click('Vault', 'tab');
  await popup.observeResize();
  await popup.click('Lock'); await popup.waitText('Master password');
  await popup.waitWidth(420, 440);
  assert(await popup.hadIntermediateWidth(), 'Native popup width should animate between locked and unlocked sizes');
  assert((await popup.viewportSize()).width <= 440, 'Lock must restore the compact popup');
  await popup.waitHeight(280, 300);
  assert((await popup.viewportSize()).height <= 300, 'Unlock should fit its short form');
  await popup.screenshot(path.join(output, 'unlock-light.png'));
  assert(!await popup.hasText('synthetic@example.test'));
  await popup.click('Settings');
  await popup.waitText('Appearance');
  await popup.click('Appearance');
  await popup.screenshot(path.join(output, 'settings-light.png'));
  await popup.select('select:has(option[value=dark])', 'dark');
  await popup.screenshot(path.join(output, 'settings-dark.png'));
  await popup.click('Back');
  await popup.screenshot(path.join(output, 'unlock-dark.png'));
  await popup.fill('input[type=password]', api.password); await popup.click('Unlock'); await popup.waitText('Synthetic account');
  await popup.click('Synthetic account app.example.test · Vault: Personal'); await popup.waitText('synthetic@example.test');
  await popup.screenshot(path.join(output, 'entry-dark.png'));
  assert.deepEqual(api.errors, []);
  console.log('PASS: native popup sign-in, create Entry, decrypt detail, create/revoke encrypted share, audit directory, lock/unlock and light/dark screenshots.');
} finally { popup?.close(); await context?.close(); await api.close(); await rm(profile, { recursive: true, force: true }); }
