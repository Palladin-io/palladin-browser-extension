import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/package-firefox-store.py');
const roots: string[] = [];
const env = { ...process.env, RELEASE_OPERATION: 'package', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), PALLADIN_STORE_CHANNEL: 'stable',
  VITE_API_URL: 'https://api.palladin.io', VITE_WEB_APP_URL: 'https://panel.example.org',
  VITE_SHARED_UNLOCK_ENVIRONMENTS: '[{"apiUrl":"https://api.palladin.io","webOrigin":"https://panel.example.org"}]' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'palladin-amo-')); roots.push(root);
  for (const dir of ['manifest', 'src', 'dist/firefox']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['package.json', 'manifest/manifest.base.json', 'dist/firefox/manifest.json']) {
    writeFileSync(join(root, file), JSON.stringify({ version: '0.1.3' }));
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.3', packages: { '': { version: '0.1.3' } } }));
  for (const file of ['tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'src/example.ts']) {
    writeFileSync(join(root, file), 'fixture');
  }
  writeFileSync(join(root, 'dist/firefox/worker.js'), '/* fixture worker */');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}
function archive(root: string, name: string) {
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))',
    `dist/firefox-store/${name}`], { cwd: root }).toString()) as Record<string, string>;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('AMO reviewer artifacts', () => {
  it('keeps the exact built resources and reproducible sources without local or unrelated files', () => {
    const root = fixture();
    writeFileSync(join(root, '.env.local'), 'PRIVATE_FIXTURE');
    writeFileSync(join(root, 'src/untracked.ts'), 'UNTRACKED_FIXTURE');
    writeFileSync(join(root, 'unrelated.txt'), 'UNRELATED_FIXTURE');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: root });
    execFileSync('python3', [script], { cwd: root, env });
    const resources = archive(root, 'package.zip');
    expect(resources).toEqual({ 'manifest.json': '{"version":"0.1.3"}', 'worker.js': '/* fixture worker */' });
    const sources = archive(root, 'sources.zip');
    expect(sources['src/example.ts']).toBe('fixture');
    expect(sources['package-lock.json']).toBe(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    expect(sources['reviewer-build.mjs']).toContain("['run', 'build:firefox']");
    expect(Object.keys(sources)).not.toContain('.env.local');
    expect(Object.keys(sources)).not.toContain('src/untracked.ts');
    expect(Object.keys(sources)).not.toContain('unrelated.txt');
    expect(JSON.parse(sources['reviewer-config.json']!)).toEqual({
      VITE_API_URL: env.VITE_API_URL, VITE_WEB_APP_URL: env.VITE_WEB_APP_URL,
      VITE_SHARED_UNLOCK_ENVIRONMENTS: env.VITE_SHARED_UNLOCK_ENVIRONMENTS, VITE_POSTHOG_KEY: '',
    });
    const first = readFileSync(join(root, 'dist/firefox-store/sources.zip'));
    execFileSync('python3', [script], { cwd: root, env });
    expect(readFileSync(join(root, 'dist/firefox-store/sources.zip'))).toEqual(first);
  });
  it('rejects a tracked symlink instead of exporting its target', () => {
    const root = fixture();
    writeFileSync(join(root, 'private.txt'), 'PRIVATE_FIXTURE');
    symlinkSync('../private.txt', join(root, 'src/escape.ts'));
    execFileSync('git', ['add', 'src/escape.ts'], { cwd: root });
    expect(spawnSync('python3', [script], { cwd: root, env }).status).not.toBe(0);
  });
});
