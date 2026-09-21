import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import manifest from '../manifest/manifest.chromium.json';

const script = resolve('scripts/package-chrome-store.py');
const directories: string[] = [];
const env = { ...process.env, RELEASE_OPERATION: 'package', VITE_API_URL: 'https://api.palladin.io',
  VITE_WEB_APP_URL: 'https://panel.example.org', VITE_SHARED_UNLOCK_ENVIRONMENTS: '[]', GITHUB_SHA: 'a'.repeat(40) };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'palladin-store-package-')); directories.push(root);
  mkdirSync(join(root, 'dist/chromium'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(root, 'dist/chromium/manifest.json'), JSON.stringify({ ...manifest, version: '0.1.0' }));
  writeFileSync(join(root, 'dist/chromium/worker.js'), '/* synthetic worker */');
  return root;
}
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('Chrome archive packaging', () => {
  it('creates a deterministic ZIP rooted at manifest.json and marks bootstrap artifacts', () => {
    const root = fixture();
    const settings = { ...env, RELEASE_OPERATION: 'bootstrap', VITE_WEB_APP_URL: 'http://localhost:5173' };
    execFileSync('python3', [script], { cwd: root, env: settings });
    const first = readFileSync(join(root, 'dist/chrome-store/package.zip'));
    execFileSync('python3', [script], { cwd: root, env: settings });
    expect(readFileSync(join(root, 'dist/chrome-store/package.zip'))).toEqual(first);
    const names = execFileSync('python3', ['-c', 'import zipfile,json;print(json.dumps(zipfile.ZipFile("dist/chrome-store/package.zip").namelist()))'], { cwd: root }).toString();
    expect(JSON.parse(names)).toEqual(['manifest.json', 'worker.js']);
    expect(JSON.parse(readFileSync(join(root, 'dist/chrome-store/release.json'), 'utf8')).bootstrap).toBe(true);
  });
  it.each(['', 'http://localhost:5173', 'https://user:password@panel.example.org', 'https://panel.invalid', 'https://panel.example.org/?token=x'])('rejects an unset or unsafe panel URL: %s', url => {
    const result = spawnSync('python3', [script, '--check-config'], { env: { ...env, VITE_WEB_APP_URL: url } });
    expect(result.status).not.toBe(0);
  });
  it.each(['.env', 'worker.js.map', 'key.pem'])('refuses accidental sensitive/build files: %s', name => {
    const root = fixture(); writeFileSync(join(root, 'dist/chromium', name), 'synthetic');
    expect(spawnSync('python3', [script], { cwd: root, env }).status).not.toBe(0);
  });
  it('rejects a symlinked build directory', () => {
    const root = fixture();
    renameSync(join(root, 'dist/chromium'), join(root, 'dist/external'));
    symlinkSync(join(root, 'dist/external'), join(root, 'dist/chromium'));
    expect(spawnSync('python3', [script], { cwd: root, env }).status).not.toBe(0);
  });
  it('does not follow symlinks outside the build', () => {
    const root = fixture();
    symlinkSync(join(root, 'package.json'), join(root, 'dist/chromium/outside.json'));
    expect(spawnSync('python3', [script], { cwd: root, env }).status).not.toBe(0);
  });
});
