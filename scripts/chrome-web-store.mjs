import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only these controlled messages may enter CI logs; native/API errors stay private.
class ReleaseError extends Error {}

export function extensionId(publicKey) {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  const der = key.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}

export function validateRelease(metadata, archive, env, operation = 'publish') {
  if (!['upload', 'review', 'publish'].includes(operation)) throw new ReleaseError('Select upload, review or publish');
  if ((operation !== 'review' && env.CWS_RELEASE_READY !== 'true') || env.CWS_VISIBILITY !== 'unlisted') {
    throw new ReleaseError('Complete the release gates and confirm Unlisted in the store environment');
  }
  validateStore(env);
  if (operation === 'review' && env.CWS_CHANNEL !== 'stable') throw new ReleaseError('Staged review requires the stable channel');
  if (metadata.bootstrap !== false
    || !['https://api.palladin.io', 'https://api.stage.palladin.io'].includes(env.CWS_API_URL)
    || metadata.apiUrl !== env.CWS_API_URL || metadata.webAppUrl !== env.CWS_WEB_APP_URL
    || metadata.commit !== env.GITHUB_SHA || !/^[0-9a-f]{40}$/.test(metadata.commit ?? '')
    || metadata.sha256 !== createHash('sha256').update(archive).digest('hex')) {
    throw new ReleaseError('Release artifact identity, checksum or configuration mismatch');
  }
  const parts = String(metadata.version).split('.');
  if (!/^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}$/.test(metadata.version)
    || parts.some(part => Number(part) > 65535) || !parts.some(part => Number(part) > 0)) {
    throw new ReleaseError('Invalid release version');
  }
  if (metadata.channel !== env.CWS_CHANNEL || !['stable', 'beta'].includes(metadata.channel)) {
    throw new ReleaseError('Artifact and store channels differ');
  }
  if (metadata.channel === 'stable' && (!/^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(env.GITHUB_REF ?? '')
    || env.GITHUB_REF !== `refs/tags/v${metadata.version}`)) {
    throw new ReleaseError('Stable store uploads require a matching release tag');
  }
  if (metadata.channel === 'beta') {
    const number = Number(env.GITHUB_RUN_NUMBER);
    if (env.GITHUB_REF !== 'refs/heads/main' || !Number.isSafeInteger(number) || number < 1 || number > 4294967295
      || metadata.version !== `0.0.${Math.floor(number / 65536)}.${number % 65536}`) {
      throw new ReleaseError('Beta store uploads require main and the current CI run version');
    }
  }
  if (extensionId(metadata.publicKey) !== env.CWS_EXTENSION_ID) {
    throw new ReleaseError('Store Item ID differs from the reviewed manifest/native-runtime identity');
  }
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function validateStore(env) {
  if (!/^[a-zA-Z0-9_-]+$/.test(env.CWS_PUBLISHER_ID ?? '')
    || !/^[a-p]{32}$/.test(env.CWS_EXTENSION_ID ?? '')) throw new ReleaseError('Configure the store publisher and item IDs');
  if (!((env.CWS_CHANNEL === 'beta' && env.GITHUB_REF === 'refs/heads/main')
    || (env.CWS_CHANNEL === 'stable' && /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(env.GITHUB_REF ?? '')))) {
    throw new ReleaseError('Select main for beta or a release tag for stable');
  }
}

function storeClient(env, request) {
  validateStore(env);
  if (!env.CWS_ACCESS_TOKEN) throw new ReleaseError('Supply a short-lived access token');
  const name = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
  const base = 'https://chromewebstore.googleapis.com';
  return async function call(path, options = {}) {
    let response;
    try {
      response = await request(`${base}${path}`, { ...options, redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${env.CWS_ACCESS_TOKEN}`, ...options.headers } });
    } catch { throw new ReleaseError('Chrome Web Store network request failed; inspect store status before retrying'); }
    // Never print an OAuth token, request headers, or an arbitrary API error body.
    if (!response.ok) throw new ReleaseError(`Chrome Web Store request failed (HTTP ${response.status})`);
    let result;
    try { result = await response.json(); } catch { throw new ReleaseError('Chrome Web Store returned invalid JSON'); }
    if (result.name !== name || result.itemId !== env.CWS_EXTENSION_ID) {
      throw new ReleaseError('Chrome Web Store returned a different item identity');
    }
    return result;
  };
}

export async function fetchStoreStatus({ env, request = fetch }) {
  const call = storeClient(env, request);
  const status = await call(`/v2/publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}:fetchStatus`);
  // Emit only finite status vocabulary and numeric versions, never arbitrary API text.
  const states = ['ITEM_STATE_UNSPECIFIED', 'PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED'];
  function revision(value) {
    if (!value) return null;
    return { state: states.includes(value.state) ? value.state : 'UNKNOWN',
      versions: (value.distributionChannels ?? []).map(channel =>
        /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}$/.test(channel.crxVersion) ? channel.crxVersion : 'UNKNOWN') };
  }
  return { published: revision(status.publishedItemRevisionStatus),
    submitted: revision(status.submittedItemRevisionStatus),
    takenDown: status.takenDown === true, warned: status.warned === true };
}

export async function uploadRelease({ operation, metadata, archive, env,
  request = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  validateRelease(metadata, archive, env, operation);
  const name = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
  const call = storeClient(env, request);
  const status = await call(`/v2/${name}:fetchStatus`);
  if (extensionId(status.publicKey) !== env.CWS_EXTENSION_ID
    || status.publicKey !== metadata.publicKey) throw new ReleaseError('Store public key differs from the release manifest');
  if (status.takenDown || status.warned) throw new ReleaseError('Resolve the store policy status before uploading');
  const staged = operation === 'publish' && status.submittedItemRevisionStatus?.state === 'STAGED'
    && status.submittedItemRevisionStatus.distributionChannels?.length > 0
    && status.submittedItemRevisionStatus.distributionChannels.every(channel => channel.crxVersion === metadata.version);
  if (['PENDING_REVIEW', 'STAGED'].includes(status.submittedItemRevisionStatus?.state) && !staged) {
    throw new ReleaseError('An existing submission is under review or staged; finish it before uploading');
  }
  for (const channel of status.publishedItemRevisionStatus?.distributionChannels ?? []) {
    if (compareVersions(metadata.version, channel.crxVersion) <= 0) {
      throw new ReleaseError('Increase the manifest version above the published version');
    }
  }
  if (!staged) {
    const uploaded = await call(`/upload/v2/${name}:upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archive,
    });
    if (uploaded.uploadState === 'SUCCEEDED' && uploaded.crxVersion !== metadata.version) {
      throw new ReleaseError('Uploaded version differs from the release artifact');
    }
    let state = uploaded.uploadState;
    for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 24; attempt++) {
      await sleep(5_000);
      state = (await call(`/v2/${name}:fetchStatus`)).lastAsyncUploadState;
    }
    if (state !== 'SUCCEEDED') throw new ReleaseError('Upload failed or did not finish within two minutes; no publication requested');
  }
  if (operation === 'upload') return 'UPLOADED_DRAFT';
  const published = await call(`/v2/${name}:publish`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: operation === 'review' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
  });
  const expectedStates = operation === 'review' ? ['PENDING_REVIEW', 'STAGED'] : ['PENDING_REVIEW', 'PUBLISHED'];
  if (!expectedStates.includes(published.state)) {
    throw new ReleaseError('Unexpected publication state; inspect the dashboard before retrying');
  }
  return published.state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, directory] = process.argv.slice(2);
    if (operation === 'status' || operation === 'status-check') {
      validateStore(process.env);
      console.log(operation === 'status-check' ? 'Chrome Web Store: CONFIGURATION_VERIFIED'
        : `Chrome Web Store: ${JSON.stringify(await fetchStoreStatus({ env: process.env }))}`);
    } else {
      const metadata = JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8'));
      const archive = await readFile(resolve(directory, 'package.zip'));
      validateRelease(metadata, archive, process.env, operation === 'check' ? process.env.CWS_OPERATION : operation);
      const state = operation === 'check' ? 'ARTIFACT_VERIFIED'
        : await uploadRelease({ operation, metadata, archive, env: process.env });
      console.log(`Chrome Web Store: ${state}`);
    }
  } catch (error) {
    console.error(error instanceof ReleaseError ? error.message
      : 'Chrome Web Store operation failed. Check artifact identity and dashboard status. No automatic retry.');
    process.exitCode = 1;
  }
}
