// @vitest-environment jsdom
import { observeNativeSubmit } from './manual-submit.test-helper';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InlineAutofillCommand } from '@shared/messaging';
import { performBoundFill } from './fill';
import { startInlineAutofill } from './inline-autofill';

let controller: ReturnType<typeof startInlineAutofill> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { chrome: { runtime: { sendMessage: vi.fn() }, storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } } });
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { return attach.call(this, { ...init, mode: 'open' }); });
  document.body.innerHTML = '<form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>';
});
afterEach(() => { controller?.stop(); controller = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture(automatic = false) {
  const username = document.querySelector<HTMLInputElement>('#username')!;
  const password = document.querySelector<HTMLInputElement>('#password')!;
  const submit = observeNativeSubmit(document.querySelector('form')!);
  const pending: { apply(): boolean; reply(): void; id: string }[] = [];
  let initialList = true;
  const send = async (command: InlineAutofillCommand): Promise<unknown> => {
    if (command.type === 'inline/list') {
      const entries = initialList && !automatic ? [] : ['Alpha', 'Beta'].map(name => ({ vaultId: 'v', entryId: name, name,
        username: name, vaultName: 'Fixture', urlDomain: 'example.test', updatedAt: '2026-09-20', match: 'exact' }));
      initialList = false; return { ok: true, kind: 'suggestions', status: 'ready', entries };
    }
    if (command.type !== 'inline/fill') return { ok: false };
    return new Promise(resolve => {
      let ok = false;
      pending.push({ id: command.loginTargetId, apply() {
        ok = performBoundFill(document, { channel: 'palladin.fill/request', documentId: 'doc', expectedOrigin: 'https://example.test',
          expectedDomain: 'example.test', submit: false, loginTargetId: command.loginTargetId, intent: command.intent,
          fields: [{ kind: 'username', value: command.entryId }, { kind: 'password', value: `synthetic-${command.entryId}` }] },
        'https://example.test/login', 'doc', controller!.resolveLoginTarget(command.loginTargetId)).ok;
        return ok;
      }, reply() { resolve({ ok: true, kind: 'fill', status: ok ? 'filled' : 'no-form' }); } });
    });
  };
  controller = startInlineAutofill(document, 'a'.repeat(32), send);
  const choose = async (name: string, login: boolean) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    controller!.invalidateSuggestions();
    const root = document.querySelector('palladin-autofill')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.launcher')!.click();
    await vi.waitFor(() => expect(root.querySelector('.option')).not.toBeNull());
    const button = login ? root.querySelector<HTMLButtonElement>(`[aria-label="Fill and log in: ${name}"]`)
      : [...root.querySelectorAll<HTMLButtonElement>('.option')].find(button => button.textContent?.startsWith(name));
    button!.click();
  };
  return { username, password, submit, pending, choose };
}
it('never uses a later fill-only operation receipt for an earlier login reply', async () => {
  const f = fixture(); await f.choose('Alpha', true);
  expect(f.pending[0]!.apply()).toBe(true);
  await f.choose('Beta', false); expect(f.pending[1]!.apply()).toBe(true);
  f.pending[0]!.reply(); await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.username.value).toBe('Beta'); expect(f.submit).not.toHaveBeenCalled();
  f.pending[1]!.reply();
});
it('cancels a completed fill receipt on lock before its worker reply', async () => {
  const f = fixture(); await f.choose('Alpha', true); expect(f.pending[0]!.apply()).toBe(true);
  controller!.clearSessionState(); f.pending[0]!.reply();
  await new Promise(resolve => setTimeout(resolve, 20)); expect(f.submit).not.toHaveBeenCalled();
});
it('does not overwrite typing that happened while the worker request was pending', async () => {
  const f = fixture(); await f.choose('Alpha', true); f.password.value = 'typed-during-request';
  expect(f.pending[0]!.apply()).toBe(false); f.pending[0]!.reply();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.password.value).toBe('typed-during-request'); expect(f.submit).not.toHaveBeenCalled();
});
it('rejects a queued DOM delivery after lock', async () => {
  const f = fixture(); await f.choose('Alpha', true); controller!.clearSessionState();
  expect(f.pending[0]!.apply()).toBe(false); f.pending[0]!.reply();
  expect(f.password.value).toBe('');
});
it('rechecks the session epoch after asynchronous framework settling', async () => {
  const f = fixture(); await f.choose('Alpha', true); expect(f.pending[0]!.apply()).toBe(true);
  f.pending[0]!.reply(); queueMicrotask(() => controller!.clearSessionState());
  await new Promise(resolve => setTimeout(resolve, 20)); expect(f.submit).not.toHaveBeenCalled();
});


it('lets a manual choice supersede a queued automatic fill without writing the old account', async () => {
  const f = fixture(true); await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  await f.choose('Beta', true);
  expect(f.pending[0]!.id).not.toBe(f.pending[1]!.id);
  expect(f.pending[0]!.apply()).toBe(false);
  expect(f.pending[1]!.apply()).toBe(true);
  f.pending[0]!.reply(); f.pending[1]!.reply();
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  expect(f.username.value).toBe('Beta'); expect(f.password.value).toBe('synthetic-Beta');
});

it('consumes the local delivery identity only once', async () => {
  const f = fixture(); await f.choose('Alpha', false);
  expect(f.pending[0]!.apply()).toBe(true);
  expect(controller!.resolveLoginTarget(f.pending[0]!.id)).toBeNull();
  f.pending[0]!.reply();
});
