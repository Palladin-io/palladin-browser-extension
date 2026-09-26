import { createHash, createPublicKey } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import manifest from '../manifest/manifest.chromium.json';
import { extensionId, fetchStoreStatus, uploadRelease, validateRelease } from './chrome-web-store.mjs';

const archive = Buffer.from('synthetic archive bytes');
const id = extensionId(manifest.key);
const env = { CWS_RELEASE_READY: 'true', CWS_VISIBILITY: 'unlisted', CWS_PUBLISHER_ID: 'test-publisher',
  CWS_EXTENSION_ID: id, CWS_ACCESS_TOKEN: 'synthetic-token', GITHUB_SHA: 'a'.repeat(40),
  CWS_API_URL: 'https://api.palladin.io', CWS_WEB_APP_URL: 'https://panel.example.org',
  CWS_CHANNEL: 'stable', GITHUB_REF: 'refs/tags/v0.1.0' };
const metadata = { bootstrap: false, channel: 'stable', apiUrl: 'https://api.palladin.io', webAppUrl: 'https://panel.example.org',
  version: '0.1.0', commit: env.GITHUB_SHA, publicKey: manifest.key,
  sha256: createHash('sha256').update(archive).digest('hex') };
const identity = { name: `publishers/test-publisher/items/${id}`, itemId: id };
const status = { publicKey: manifest.key };
const success = { uploadState: 'SUCCEEDED', crxVersion: '0.1.0' };
function fake(...responses: object[]) {
  return vi.fn(async () => new Response(JSON.stringify({ ...identity, ...responses.shift() }), { status: 200 }));
}
function run(request: ReturnType<typeof fake>, operation = 'upload') {
  return uploadRelease({ operation, metadata, archive, env, request, sleep: async () => {} });
}

describe('Chrome Web Store release boundary', () => {
  it('uploads a draft without calling publish and sends credentials only to Google', async () => {
    const request = fake(status, success);
    expect(await run(request)).toBe('UPLOADED_DRAFT');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(expect.stringContaining(':upload'), expect.objectContaining({
      method: 'POST', body: archive, redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/zip' },
    }));
  });
  it.each([
    { bootstrap: true }, { commit: 'b'.repeat(40) }, { sha256: 'bad' }, { version: '0.0.0' },
    { channel: 'beta' },
  ])('rejects an invalid artifact before network access: %j', patch => {
    expect(() => validateRelease({ ...metadata, ...patch }, archive, env)).toThrow();
  });
  it.each([
    { CWS_EXTENSION_ID: 'b'.repeat(32) }, { CWS_RELEASE_READY: '' },
    { CWS_VISIBILITY: 'public' }, { CWS_PUBLISHER_ID: '../another' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/tags/v0.2.0' },
    { GITHUB_REF: 'refs/tags/v0.1.0-rc.1' },
  ])('requires the reviewed deployment and exact item: %j', patch => {
    expect(() => validateRelease(metadata, archive, { ...env, ...patch })).toThrow();
  });
  it('accepts a beta only for the selected beta environment and exact main run', () => {
    const beta = { ...metadata, channel: 'beta', version: '0.0.1.0' };
    const settings = { ...env, CWS_CHANNEL: 'beta', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: '65536' };
    expect(() => validateRelease(beta, archive, settings)).not.toThrow();
    expect(() => validateRelease(beta, archive, { ...settings, GITHUB_RUN_NUMBER: '65535' })).toThrow();
    expect(() => validateRelease(beta, archive, { ...settings, GITHUB_REF: 'refs/tags/v0.1.0' })).toThrow();
    expect(() => validateRelease(beta, archive, { ...settings, CWS_CHANNEL: 'stable' })).toThrow();
  });
  it('uploads the selected staging artifact without changing the store channel', async () => {
    const request = fake(status, success);
    const staging = { ...metadata, apiUrl: 'https://api.stage.palladin.io', webAppUrl: 'https://stage.palladin.io' };
    expect(await uploadRelease({ operation: 'upload', metadata: staging, archive,
      env: { ...env, CWS_API_URL: staging.apiUrl, CWS_WEB_APP_URL: staging.webAppUrl }, request,
    })).toBe('UPLOADED_DRAFT');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { CWS_API_URL: '' }, { CWS_API_URL: 'https://api.stage.palladin.io' },
    { CWS_WEB_APP_URL: '' }, { CWS_WEB_APP_URL: 'https://stage.palladin.io' },
  ])('rejects deployment URL drift before contacting Google: %j', async patch => {
    const request = fake(status, success);
    await expect(uploadRelease({ operation: 'upload', metadata, archive,
      env: { ...env, ...patch }, request,
    })).rejects.toThrow('configuration mismatch');
    expect(request).not.toHaveBeenCalled();
  });
  it('never publishes after an upload failure', async () => {
    const request = fake(status, { uploadState: 'FAILED' });
    await expect(run(request, 'publish')).rejects.toThrow('Upload failed');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('waits for asynchronous processing and submits with review and warning checks', async () => {
    const request = fake(status, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' },
      { state: 'PENDING_REVIEW' });
    expect(await run(request, 'publish')).toBe('PENDING_REVIEW');
    expect(request).toHaveBeenLastCalledWith(expect.stringContaining(':publish'), expect.objectContaining({
      body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
    }));
  });
  it('bounds asynchronous polling without publishing after timeout', async () => {
    const request = fake(status, { uploadState: 'IN_PROGRESS' },
      ...Array.from({ length: 24 }, () => ({ lastAsyncUploadState: 'IN_PROGRESS' })));
    await expect(run(request, 'publish')).rejects.toThrow('two minutes');
    expect(request).toHaveBeenCalledTimes(26);
  });
  it.each([
    { publicKey: '' }, { itemId: 'b'.repeat(32) }, { takenDown: true }, { warned: true },
    { submittedItemRevisionStatus: { state: 'STAGED' } },
    { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } },
    { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.1.0' }] } },
    { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.10.0' }] } },
  ])('does not mutate an incompatible store item: %j', patch => {
    const request = fake({ ...status, ...patch });
    return expect(run(request, 'publish')).rejects.toThrow().then(() => expect(request).toHaveBeenCalledTimes(1));
  });
  it('does not publish when the uploaded version differs', async () => {
    const request = fake(status, { ...success, crxVersion: '0.2.0' });
    await expect(run(request, 'publish')).rejects.toThrow('Uploaded version differs');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not expose the API response body on authorization errors', async () => {
    const request = vi.fn(async () => new Response('synthetic-sensitive-response', { status: 401 }));
    await expect(run(request)).rejects.toThrow('Chrome Web Store request failed (HTTP 401)');
    expect(request).toHaveBeenCalledTimes(1);
  });
});


describe('staged review and read-only status', () => {
  it('submits for staged review with the live release gate closed', async () => {
    const request = fake(status, success, { state: 'PENDING_REVIEW' });
    expect(await uploadRelease({ operation: 'review', metadata, archive,
      env: { ...env, CWS_RELEASE_READY: 'false' }, request })).toBe('PENDING_REVIEW');
    expect(request).toHaveBeenLastCalledWith(expect.stringContaining(':publish'), expect.objectContaining({
      body: JSON.stringify({ publishType: 'STAGED_PUBLISH', skipReview: false, blockOnWarnings: true }),
    }));
  });
  it.each(['publish', 'upload', 'unknown'])('keeps the readiness gate for %s', async operation => {
    const request = fake(status, success);
    await expect(uploadRelease({ operation, metadata, archive,
      env: { ...env, CWS_RELEASE_READY: 'false' }, request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { CWS_VISIBILITY: 'public' }, { GITHUB_REF: 'refs/heads/main' },
    { CWS_API_URL: 'https://api.stage.palladin.io' }, { CWS_EXTENSION_ID: 'b'.repeat(32) },
  ])('preserves release identity checks for staged review: %j', async patch => {
    const request = fake(status, success);
    await expect(uploadRelease({ operation: 'review', metadata, archive,
      env: { ...env, CWS_RELEASE_READY: 'false', ...patch }, request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('publishes the matching approved version without another upload', async () => {
    const request = fake({ ...status, submittedItemRevisionStatus: { state: 'STAGED',
      distributionChannels: [{ crxVersion: metadata.version }] } }, { state: 'PUBLISHED' });
    expect(await run(request, 'publish')).toBe('PUBLISHED');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(expect.stringContaining(':publish'), expect.objectContaining({
      body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
    }));
  });
  it.each(['0.0.9', '0.2.0'])('does not release a different staged version %s', async crxVersion => {
    const request = fake({ ...status, submittedItemRevisionStatus: { state: 'STAGED',
      distributionChannels: [{ crxVersion }] } });
    await expect(run(request, 'publish')).rejects.toThrow('existing submission');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('reads status with the live gate closed and emits only selected value-free data', async () => {
    const request = fake({ ...status, arbitraryText: 'do not log',
      publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.0.9' }] },
      submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.1.0' }] },
    });
    expect(await fetchStoreStatus({ env: { ...env, CWS_RELEASE_READY: 'false' }, request })).toEqual({
      publicKeyFormat: 'BASE64_DER', published: { state: 'PUBLISHED', versions: ['0.0.9'] },
      submitted: { state: 'PENDING_REVIEW', versions: ['0.1.0'] }, takenDown: false, warned: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.stringContaining(':fetchStatus'), expect.not.objectContaining({ method: 'POST' }));
  });
  it('does not emit arbitrary status/version text', async () => {
    const request = fake({ submittedItemRevisionStatus: { state: 'secret text',
      distributionChannels: [{ crxVersion: 'secret text' }] } });
    expect(await fetchStoreStatus({ env, request })).toEqual({ publicKeyFormat: 'MISSING', published: null,
      submitted: { state: 'UNKNOWN', versions: ['UNKNOWN'] }, takenDown: false, warned: false });
  });
  it('rejects a substituted status item', async () => {
    await expect(fetchStoreStatus({ env, request: fake({ itemId: 'b'.repeat(32) }) })).rejects.toThrow('different item');
  });
  it.each([{ CWS_EXTENSION_ID: '../other' }, { CWS_CHANNEL: 'stable', GITHUB_REF: 'refs/heads/main' }])(
    'rejects invalid status configuration before contacting Google: %j', async patch => {
      const request = fake(status);
      await expect(fetchStoreStatus({ env: { ...env, ...patch }, request })).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    });
});


describe('store public-key encoding', () => {
  const pem = createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' })
    .export({ format: 'pem', type: 'spki' }).toString();
  it('compares the complete public key independently of PEM/base64 DER encoding', async () => {
    expect(extensionId(pem)).toBe(id);
    expect(await run(fake({ ...status, publicKey: pem }, success))).toBe('UPLOADED_DRAFT');
  });
  it('reports the encoding without returning the key', async () => {
    const result = await fetchStoreStatus({ env, request: fake({ ...status, publicKey: pem }) });
    expect(result.publicKeyFormat).toBe('PEM');
    expect(JSON.stringify(result)).not.toContain(pem);
  });
  it.each([undefined, '', 'not a key', '-----BEGIN PRIVATE KEY-----'])('rejects malformed/missing keys without a raw crypto error', async publicKey => {
    const request = fake({ ...status, publicKey }, success);
    await expect(run(request)).rejects.toThrow('Invalid extension public key');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
