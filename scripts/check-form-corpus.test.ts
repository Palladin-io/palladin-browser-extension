import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const checker = resolve('scripts/check-form-corpus.mjs');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function scenario(change: 'none' | 'missing' | 'partial' | 'wrong-flow' | 'wrong-source' | 'empty-not-offered') {
  const root = mkdtempSync(join(tmpdir(), 'palladin-corpus-check-'));
  roots.push(root);
  const directory = join(root, 'tests/fixtures/forms');
  mkdirSync(directory, { recursive: true });
  const source = { url: 'https://account.example.test/form', observedAt: '2026-09-15' };
  const service = { id: 'example', regions: ['global'], login: 'observed', registration: 'observed',
    fixtures: ['login', 'registration'], evidence: {
      login: [{ fixture: 'login', source: source.url, observedAt: source.observedAt, stage: null }],
      registration: [{ fixture: 'registration', source: source.url, observedAt: source.observedAt, stage: null }],
    } };
  for (const flow of ['login', 'registration']) {
    if (change === 'missing' && flow === 'registration') continue;
    mkdirSync(join(directory, flow));
    writeFileSync(join(directory, flow, 'case.json'), JSON.stringify({
      id: flow, service: 'example', flow: change === 'wrong-flow' && flow === 'registration' ? 'login' : flow,
      source: change === 'wrong-source' && flow === 'registration' ? { ...source, url: 'https://other.example.test/' } : source,
      ...(change === 'partial' && flow === 'registration' ? { stage: 'identifier' } : {}),
      expected: { capture: { kind: flow } },
    }));
  }
  const coverage = { targets: { global: 1 }, services: [service] };
  const serialized = JSON.stringify(coverage);
  writeFileSync(join(directory, 'coverage.json'), change === 'empty-not-offered'
    ? serialized.replace('"registration":"observed"', '"registration":"not-offered"') : serialized);
  return () => execFileSync(process.execPath, [checker, '--complete'], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
}

it('counts a service only when both claims match their full-flow specimens and provenance', () => {
  expect(JSON.parse(scenario('none')()).regions.global.fullyObserved).toBe(1);
});
it.each(['missing', 'partial', 'wrong-flow', 'wrong-source', 'empty-not-offered'] as const)(
  'rejects a declared complete service with %s evidence', change => {
    expect(scenario(change)).toThrow();
  },
);

it('ignores explicitly unindexed README-only regression directories without counting them as coverage', () => {
  const run = scenario('none');
  const extra = join(roots.at(-1)!, 'tests/fixtures/forms/unindexed-current-main-regression');
  mkdirSync(extra);
  writeFileSync(join(extra, 'README.md'), 'Separate regression without corpus case metadata.');
  const result = JSON.parse(run());
  expect(result.specimens).toBe(2);
  expect(result.observedServices).toBe(1);
});
