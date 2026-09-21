// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://forms.example.test/login"}
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginTargetFor, performLoginTargetFill } from './fill';
import { CredentialSubmissionObserver, isCaptureVisible, readSubmittedCredential } from './credential-submission';
import { LiveLogin } from './agent-live-login';
import { describeAgentFormControl } from './agent-form-controls';
import { credentialScopeFor } from './login-controls';

const replaySource = readFileSync('scripts/replay-form-specimen.mjs', 'utf8').replaceAll('export function', 'function');
const replay = new Function(replaySource + '; return { hydrateFormSpecimen, querySpecimen, installFormActionActivation };')() as {
  hydrateFormSpecimen(root: Element, css: string): void;
  querySpecimen(root: Document, selector: string): Element[];
  installFormActionActivation(root: Document, activation: Specimen['actionActivation']): void;
};
function queryAll<T extends Element = Element>(selector: string): T[] {
  return replay.querySpecimen(document, selector) as T[];
}
function query<T extends Element = Element>(selector: string): T | null { return queryAll<T>(selector)[0] ?? null; }

interface Specimen {
  id: string;
  service: string;
  flow: 'login' | 'registration' | 'non-auth';
  stage?: 'identifier' | 'name' | 'account-details' | 'cross-frame' | 'verification';
  synthetic?: { username?: string; passwordLength?: number };
  activation?: { kind: 'focus-removes-readonly'; selectors: string[] };
  actionActivation?: { kind: 'nonempty-fields'; action: string; fields: string[]; disabledClass: string; opacity: { disabled: string; enabled: string } };
  source: { url: string; observedAt: string; method: string };
  expected: {
    user: { anchor: string; username: string | null; password: string | null } | null;
    agent: { action?: string; observedOnly?: { selector: string; kind: string; purpose: string | null }[];
      fields: { selector: string; kind: string; purpose: string | null; fieldId: string }[] };
    capture: { kind: 'login' | 'registration' | 'password-change'; scope: string; username?: string; usernameValue?: string; passwords?: string[]; emailConfirmations?: string[];
      usernameOptions?: { email: string; nickname: string } } | null;
  };
}
// Standalone README-only main regressions are intentionally not counted here.
const cases = ['forms', 'non-auth'].flatMap(group => {
  const directory = resolve(`tests/fixtures/${group}`);
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(`${directory}/${entry.name}/case.json`))
    .map(entry => ({ directory: `${directory}/${entry.name}`, specimen: JSON.parse(readFileSync(`${directory}/${entry.name}/case.json`, 'utf8')) as Specimen }));
});
afterEach(() => { document.body.replaceChildren(); document.head.querySelectorAll('[data-corpus-style]').forEach(node => node.remove()); });

it('loads at least one production-observed specimen, not an empty passing suite', () => expect(cases.length).toBeGreaterThan(0));
for (const item of cases) {
  describe(item.specimen.id, () => {
    const synthetic = { username: item.specimen.synthetic?.username ?? 'fixture-user@example.test',
      password: 'Fixture-only-password!42'.slice(0, item.specimen.synthetic?.passwordLength) };
    function mount() {
      document.body.innerHTML = readFileSync(`${item.directory}/page.html`, 'utf8');
      const style = document.createElement('style');
      style.dataset.corpusStyle = '';
      style.textContent = readFileSync(`${item.directory}/page.css`, 'utf8');
      document.head.append(style);
      replay.hydrateFormSpecimen(document.body, style.textContent);
      replay.installFormActionActivation(document, item.specimen.actionActivation);
    }
    if (item.specimen.activation) it('keeps the observed signup out of standard login while each readonly field is activated', () => {
      document.body.innerHTML = readFileSync(`${item.directory}/initial.html`, 'utf8');
      const style = document.createElement('style');
      style.dataset.corpusStyle = '';
      style.textContent = readFileSync(`${item.directory}/initial.css`, 'utf8');
      document.head.append(style);
      for (const selector of item.specimen.activation!.selectors) {
        const input = query<HTMLInputElement>(selector)!;
        expect(input.readOnly).toBe(true);
        input.readOnly = false; // Observed site response to focus, not a detector fix.
        expect([...queryAll<HTMLInputElement>('input')].map(loginTargetFor).filter(Boolean)).toHaveLength(0);
      }
    });
    it('retains public source provenance and excludes executable/secret-bearing source data', () => {
      mount();
      expect(new URL(item.specimen.source.url).protocol).toBe('https:');
      expect(new URL(item.specimen.source.url).search).toBe('');
      expect(item.specimen.source.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.specimen.source.method).toContain('DOM');
      expect(query('script, iframe, input[value]:not([type="submit"]):not([type="button"]), textarea:not(:empty)')).toBeNull();
      for (const element of queryAll('*')) {
        expect([...element.attributes].some(attribute => /^on/i.test(attribute.name))).toBe(false);
      }
    });
    it('recognizes the exact observed user login controls and fills only that pair', () => {
      mount();
      const expected = item.specimen.expected.user;
      if (!expected) {
        expect([...queryAll<HTMLInputElement>('input')].map(loginTargetFor).filter(Boolean).length).toBe(0);
        return;
      }
      const anchor = query<HTMLInputElement>(expected.anchor)!;
      const target = loginTargetFor(anchor);
      expect(target).not.toBeNull();
      expect(target!.username).toBe(expected.username ? query(expected.username) : null);
      expect(target!.password).toBe(expected.password ? query(expected.password) : null);
      const before = new Map([...queryAll<HTMLInputElement>('input')].map(field => [field, { value: field.value, checked: field.checked }]));
      expect(performLoginTargetFill(target!, [{ kind: 'username', value: synthetic.username }, { kind: 'password', value: synthetic.password }])).toEqual({ ok: true });
      for (const field of queryAll<HTMLInputElement>('input')) {
        expect(field.value).toBe(field === target!.username ? synthetic.username : field === target!.password ? synthetic.password : before.get(field)!.value);
        expect(field.checked).toBe(before.get(field)!.checked);
      }
    });
    it('recognizes the agent field purposes on the same specimen', () => {
      mount();
      expect(item.specimen.expected.agent.fields.length).toBeGreaterThan(0);
      for (const expected of [...item.specimen.expected.agent.fields, ...item.specimen.expected.agent.observedOnly ?? []]) {
        const field = query<HTMLInputElement>(expected.selector);
        expect(field).not.toBeNull();
        expect(describeAgentFormControl(field!, 'public-ref')).toMatchObject({ kind: expected.kind, purpose: expected.purpose });
      }
    });
    // LiveLogin authorizes an existing credential, not account creation or SMS.
    // Registration action requirements remain in case.json and the browser
    // capability report as unsupported-current-adapter, never a login PASS.
    if (item.specimen.expected.agent.action && item.specimen.flow !== 'login') it('keeps registration and SMS actions outside existing-credential login authority', () => {
      mount();
      const action = query<HTMLElement>(item.specimen.expected.agent.action!)!;
      expect(action).not.toBeNull();
      const clicked = vi.fn(); action.addEventListener('click', clicked);
      const live = new LiveLogin(document, 'b'.repeat(32), () => window.location.href, () => true, { isVisible: isCaptureVisible });
      try { expect(live.inspect(window.location.href)).toBeNull(); expect(clicked).not.toHaveBeenCalled(); }
      finally { live.clear(); }
    });
    if (item.specimen.expected.agent.action && item.specimen.flow === 'login') it('supports the recorded explicit login action through the current live adapter', async () => {
      mount();
      const documentId = 'b'.repeat(32), targetUrl = window.location.href;
      const live = new LiveLogin(document, documentId, () => targetUrl, () => true, { isVisible: isCaptureVisible });
      try {
        const action = query<HTMLElement>(item.specimen.expected.agent.action!)!;
        expect(action).not.toBeNull();
        const clicked = vi.fn((event: Event) => event.preventDefault());
        action.addEventListener('click', clicked);
        const form = live.inspect(targetUrl);
        expect(form, `${item.specimen.id}: recorded explicit action is unsupported by current live discovery`).not.toBeNull();
        if (!form) return;
        expect(form.version).toBe(2);
        const values = item.specimen.expected.agent.fields.filter(field => field.fieldId.startsWith('credential.'))
          .map(field => ({ entryFieldId: field.fieldId, value: field.fieldId === 'credential.password' ? synthetic.password : synthetic.username }));
        const prepared = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'c'.repeat(32),
          documentId, expectedDomain: 'forms.example.test', expiresAt: Date.now() + 10_000, form, values });
        expect(clicked).not.toHaveBeenCalled();
        expect(prepared.ok, 'Recorded login action did not become executable').toBe(true);
        if (!prepared.ok) return;
        const commit = { channel: 'palladin.agent-live/deferred-commit' as const, expectedDomain: 'forms.example.test',
          submitReady: prepared.submitReady, expiresAt: Date.now() + 1000 };
        expect(live.commitDeferred(commit)).toEqual({ ok: true });
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(live.commitDeferred(commit).ok).toBe(false);
      } finally { live.clear(); }
    });
    it('extracts the intended synthetic credential without changing the observed markup', () => {
      mount();
      const expected = item.specimen.expected.capture;
      if (!expected) {
        // Exercise populated controls. Reading only body ignores form-owned inputs
        // and would make every native-form negative pass without testing extraction.
        for (const field of item.specimen.expected.agent.fields) {
          query<HTMLInputElement>(field.selector)!.value = field.fieldId === 'credential.password'
            ? synthetic.password : field.fieldId === 'profile.email' ? 'fixture-contact@example.test'
              : field.fieldId.startsWith('profile.') ? 'Fixture' : synthetic.username;
        }
        for (const field of item.specimen.expected.agent.observedOnly ?? []) {
          if (field.purpose === 'one-time-code') query<HTMLInputElement>(field.selector)!.value = '123456';
        }
        const scopes = new Set([document.body, ...document.forms,
          ...[...queryAll<HTMLInputElement>('input')].map(credentialScopeFor).filter((scope): scope is HTMLElement => scope !== null)]);
        for (const scope of scopes) expect(readSubmittedCredential(scope)).toBeNull();
        if (item.specimen.flow === 'non-auth' || ['account-details', 'verification'].includes(item.specimen.stage ?? '')) {
          const send = vi.fn();
          const observer = new CredentialSubmissionObserver(document, 'corpus-document-123456', send);
          try {
            for (const scope of scopes) observer.capture(scope);
            expect(send).not.toHaveBeenCalled();
          } finally { observer.stop(); }
        }
        if (item.specimen.stage === 'identifier') {
          const identity = item.specimen.expected.agent.fields.find(field => field.fieldId === 'credential.username')!;
          const field = query<HTMLInputElement>(identity.selector)!;
          field.value = synthetic.username;
          const send = vi.fn();
          const observer = new CredentialSubmissionObserver(document, 'corpus-document-123456', send);
          try {
            const scope = credentialScopeFor(field);
            expect(scope).not.toBeNull();
            observer.capture(scope!);
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'identifier', username: synthetic.username }));
          } finally { observer.stop(); }
        }
        return;
      }
      const username = query<HTMLInputElement>(expected.username ?? 'input[autocomplete~="username"], input[autocomplete~="email"]')!;
      username.value = synthetic.username;
      for (const field of item.specimen.expected.agent.fields.filter(field => field.fieldId === 'credential.username')) {
        query<HTMLInputElement>(field.selector)!.value = synthetic.username;
      }
      for (const field of item.specimen.expected.agent.fields.filter(field => field.fieldId === 'profile.email')) {
        query<HTMLInputElement>(field.selector)!.value = 'fixture-contact@example.test';
      }
      for (const field of item.specimen.expected.agent.fields.filter(field => field.fieldId === 'profile.username')) {
        query<HTMLInputElement>(field.selector)!.value = 'fixture_handle';
      }
      for (const field of item.specimen.expected.agent.fields.filter(field => field.fieldId === 'profile.tel')) {
        query<HTMLInputElement>(field.selector)!.value = '2025550100';
      }
      const passwords = expected.passwords
        ? expected.passwords.map(selector => query<HTMLInputElement>(selector)!)
        : [...queryAll<HTMLInputElement>('input[type="password"]')];
      passwords.forEach(field => { field.value = synthetic.password; });
      expect(readSubmittedCredential(query<HTMLElement>(expected.scope)!)).toEqual({ kind: expected.kind,
        username: expected.usernameOptions ? '' : expected.usernameValue ?? synthetic.username, password: synthetic.password, previousPassword: null,
        ...(expected.usernameOptions ? { usernameOptions: expected.usernameOptions } : {}) });
      for (const selector of expected.emailConfirmations ?? []) {
        query<HTMLInputElement>(selector)!.value = 'different@example.test';
        expect(readSubmittedCredential(query<HTMLElement>(expected.scope)!)).toBeNull();
      }
    });
  });
}
