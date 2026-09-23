import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import manifest from '../manifest/manifest.chromium.json';

const script = resolve('scripts/package-chrome-store.py');
const directories: string[] = [];
const env = { ...process.env, RELEASE_OPERATION: 'package', VITE_API_URL: 'https://api.palladin.io',
  VITE_WEB_APP_URL: 'https://panel.example.org', VITE_SHARED_UNLOCK_ENVIRONMENTS: '[]', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF: 'refs/heads/main', PALLADIN_STORE_CHANNEL: 'stable' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'palladin-store-package-')); directories.push(root);
  mkdirSync(join(root, 'dist/chromium'), { recursive: true });
  mkdirSync(join(root, 'manifest'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(root, 'manifest/manifest.base.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }));
  writeFileSync(join(root, 'dist/chromium/manifest.json'), JSON.stringify({ ...manifest, version: '0.1.0' }));
  writeFileSync(join(root, 'dist/chromium/worker.js'), '/* synthetic worker */');
  return root;
}
function gitFixture() {
  const root = fixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '--initial-branch=main');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { root, git, sha: git('rev-parse', 'HEAD') };
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
  it('accepts a stable tag on main and refuses an unmerged feature commit', () => {
    const { root, git, sha } = gitFixture();
    const settings = { ...env, RELEASE_OPERATION: 'publish', GITHUB_REF: 'refs/tags/v0.1.0', GITHUB_SHA: sha };
    expect(spawnSync('python3', [script, '--check-config'], { cwd: root, env: settings }).status).toBe(0);
    git('checkout', '-b', 'feature');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'unreviewed');
    expect(spawnSync('python3', [script, '--check-config'], { cwd: root,
      env: { ...settings, GITHUB_SHA: git('rev-parse', 'HEAD') } }).status).not.toBe(0);
  });
  it.each(['refs/heads/main', 'refs/tags/v0.2.0', 'refs/tags/v0.1.0-rc.1'])('rejects stable publishing with ref %s', ref => {
    expect(spawnSync('python3', [script, '--check-config'], { cwd: fixture(),
      env: { ...env, RELEASE_OPERATION: 'publish', GITHUB_REF: ref } }).status).not.toBe(0);
  });
  it('rejects version drift in the lockfile before building', () => {
    const root = fixture();
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.1.0' } } }));
    expect(spawnSync('python3', [script, '--check-config'], { cwd: root, env }).status).not.toBe(0);
  });
  it('packages a beta with the CI version, independent from the stable version', () => {
    const root = fixture();
    writeFileSync(join(root, 'dist/chromium/manifest.json'), JSON.stringify({ version: '0.0.1.0' }));
    execFileSync('python3', [script], { cwd: root, env: { ...env,
      PALLADIN_STORE_CHANNEL: 'beta', GITHUB_RUN_NUMBER: '65536', RELEASE_OPERATION: 'bootstrap' } });
    expect(JSON.parse(readFileSync(join(root, 'dist/chrome-store/release.json'), 'utf8'))).toMatchObject({
      bootstrap: true, channel: 'beta', version: '0.0.1.0', publicKey: '',
    });
  });
  it.each(['0', '1.5', '4294967296'])('rejects invalid beta run number %s', number => {
    expect(spawnSync('python3', [script, '--check-config'], { cwd: fixture(),
      env: { ...env, PALLADIN_STORE_CHANNEL: 'beta', GITHUB_RUN_NUMBER: number } }).status).not.toBe(0);
  });
  it('rejects beta builds from a release tag', () => {
    expect(spawnSync('python3', [script, '--check-config'], { cwd: fixture(), env: { ...env,
      PALLADIN_STORE_CHANNEL: 'beta', GITHUB_RUN_NUMBER: '1', GITHUB_REF: 'refs/tags/v0.1.0' } }).status).not.toBe(0);
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
