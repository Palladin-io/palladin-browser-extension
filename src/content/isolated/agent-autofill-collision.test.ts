// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://signin.aws.amazon.com/signin"}
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { clearAutomaticFillProvenance } from './automatic-fill-provenance';
import { LiveLogin } from './agent-live-login';
import { loginTargetFor, performBoundFill, discardLoginTargetFill } from './fill';

// Observed AWS structure; synthetic identities and controller calls only. This
// tests collision behavior, not the site's JavaScript or real authentication.
const url = 'https://signin.aws.amazon.com/signin';
const documentId = 'd'.repeat(32);
let live: LiveLogin | undefined;
afterEach(() => { live?.clear(); clearAutomaticFillProvenance(document); document.body.replaceChildren(); history.replaceState(null, '', '/signin'); vi.restoreAllMocks(); });

it.each(['same-entry', 'different-entry'] as const)('handles passive user autofill before explicit agent delivery: %s', choice => {
  return (async () => {
    document.body.innerHTML = readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-20/page.html', 'utf8');
    const input = document.querySelector<HTMLInputElement>('#resolving_input')!;
    const target = loginTargetFor(input)!;
    const entryA = 'synthetic-a@example.test'; const entryB = 'synthetic-b@example.test';
    expect(performBoundFill(document, { channel: 'palladin.fill/request', documentId, expectedOrigin: 'https://signin.aws.amazon.com', expectedDomain: 'signin.aws.amazon.com', submit: false, loginTargetId: 'synthetic-login', intent: 'automatic', automaticFillSessionId: 'a'.repeat(32), fields: [{ kind: 'username', value: entryA }, { kind: 'password', value: 'synthetic-unused' }] }, url, documentId, target)).toEqual({ ok: true });
    discardLoginTargetFill(target);
    const inputEvents = vi.fn(), clicks = vi.fn((event: Event) => event.preventDefault());
    input.addEventListener('input', inputEvents);
    document.querySelector('#next_button')!.addEventListener('click', clicks);
    live = new LiveLogin(document, documentId, () => url, () => true,
      { isVisible: element => !element.hidden && !element.closest('[hidden]') });
    const form = live.inspect(url)!;
    expect(form.version).toBe(2);
    const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32),
      documentId, automaticFillSessionId: 'a'.repeat(32), expectedDomain: 'signin.aws.amazon.com', expiresAt: Date.now() + 10_000, form,
      values: [{ entryFieldId: 'credential.username', value: choice === 'same-entry' ? entryA : entryB }] });
    expect(input.value).toBe(choice === 'different-entry' ? entryB : entryA); expect(inputEvents).toHaveBeenCalledTimes(choice === 'different-entry' ? 1 : 0); expect(clicks).not.toHaveBeenCalled();
    {
      expect(response.ok).toBe(true); if (!response.ok) return;
      expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'signin.aws.amazon.com',
        submitReady: response.submitReady, expiresAt: Date.now() + 1000 })).toEqual({ ok: true });
      expect(clicks).toHaveBeenCalledTimes(1);
    }
  })();
});

it.each(['no-marker', 'other-session', 'no-auto-marker', 'manual', 'pre-existing', 'input-event', 'change-event', 'page-edit',
  'new-node', 'new-owner', 'new-url', 'other-document-id', 'readonly', 'disabled', 'carried', 'lock', 'pagehide', 'expired'] as const)
('never replaces an unproven or invalidated automatic tuple: %s', async mutation => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-20/page.html', 'utf8');
  let input = document.querySelector<HTMLInputElement>('#resolving_input')!;
  const target = loginTargetFor(input)!; const marker = 'a'.repeat(32);
  if (mutation === 'pre-existing') input.value = 'synthetic-a@example.test';
  const automaticFillSessionId = mutation === 'no-auto-marker' || mutation === 'manual' ? undefined : marker;
  expect(performBoundFill(document, { channel: 'palladin.fill/request', documentId, expectedOrigin: 'https://signin.aws.amazon.com',
    expectedDomain: 'signin.aws.amazon.com', submit: false, loginTargetId: 'synthetic', intent: mutation === 'manual' ? 'manual' : 'automatic',
    ...(automaticFillSessionId ? { automaticFillSessionId } : {}), fields: [{ kind: 'username', value: 'synthetic-a@example.test' }, { kind: 'password', value: 'synthetic-unused' }] },
  url, documentId, target)).toEqual({ ok: true });
  discardLoginTargetFill(target);
  if (mutation === 'input-event' || mutation === 'change-event') input.dispatchEvent(new Event(mutation === 'input-event' ? 'input' : 'change'));
  if (mutation === 'page-edit') input.value = 'synthetic-page-edit@example.test';
  if (mutation === 'new-node') { const next = input.cloneNode(true) as HTMLInputElement; input.replaceWith(next); input = next; }
  if (mutation === 'new-owner') { const form = document.createElement('form'); form.append(input, document.querySelector('#next_button')!); document.body.append(form); }
  if (mutation === 'pagehide') window.dispatchEvent(new Event('pagehide'));
  if (mutation === 'new-url') history.replaceState(null, '', '/different');
  if (mutation === 'expired') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_001);
  if (mutation === 'lock') clearAutomaticFillProvenance(document);
  const currentId = mutation === 'other-document-id' ? 'e'.repeat(32) : documentId;
  const currentUrl = document.location.href;
  live = new LiveLogin(document, currentId, () => currentUrl, () => true, { isVisible: element => !element.hidden && !element.closest('[hidden]') });
  const form = live.inspect(currentUrl)!;
  if (mutation === 'readonly') input.readOnly = true;
  if (mutation === 'disabled') input.disabled = true;
  const click = vi.fn(); document.querySelector('#next_button')!.addEventListener('click', click);
  const before = input.value;
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId: currentId,
    expectedDomain: 'signin.aws.amazon.com', expiresAt: Date.now() + 10_000, form,
    ...(mutation === 'no-marker' ? {} : { automaticFillSessionId: mutation === 'other-session' ? 'f'.repeat(32) : marker }),
    ...(mutation === 'carried' ? { requireExistingUsername: true } : {}),
    values: [{ entryFieldId: 'credential.username', value: 'synthetic-b@example.test' }] });
  expect(response).toEqual({ ok: false, outcome: 'stale-form-map' });
  expect(input.value).toBe(before); expect(click).not.toHaveBeenCalled();
});

it('consumes automatic provenance before writing B and never restores a replacement permission after cancel', async () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>';
  const input = document.querySelector('input')!; const target = loginTargetFor(input)!;
  expect(performBoundFill(document, { channel: 'palladin.fill/request', documentId, expectedOrigin: 'https://signin.aws.amazon.com', expectedDomain: 'signin.aws.amazon.com',
    submit: false, loginTargetId: 'synthetic', intent: 'automatic', automaticFillSessionId: 'a'.repeat(32),
    fields: [{ kind: 'username', value: 'synthetic-a' }, { kind: 'password', value: 'synthetic-a-password' }] }, url, documentId, target)).toEqual({ ok: true });
  discardLoginTargetFill(target);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: () => true });
  const deliver = () => live!.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
    automaticFillSessionId: 'a'.repeat(32), expectedDomain: 'signin.aws.amazon.com', expiresAt: Date.now() + 10_000, form: live!.inspect(url)!,
    values: [{ entryFieldId: 'credential.username', value: 'synthetic-b' }, { entryFieldId: 'credential.password', value: 'synthetic-b-password' }] });
  const first = await deliver(); expect(first.ok).toBe(true); if (!first.ok) return;
  live.cancelDeferred(first.submitReady.pendingId);
  input.value = 'synthetic-a'; document.querySelector<HTMLInputElement>('[type=password]')!.value = 'synthetic-a-password';
  expect(await deliver()).toEqual({ ok: false, outcome: 'stale-form-map' });
});

it('also consumes provenance when the first agent uses the already matching Entry', async () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>';
  const target = loginTargetFor(document.querySelector('input')!)!;
  const marker = 'a'.repeat(32);
  expect(performBoundFill(document, { channel: 'palladin.fill/request', documentId, expectedOrigin: 'https://signin.aws.amazon.com', expectedDomain: 'signin.aws.amazon.com', submit: false, loginTargetId: 'synthetic', intent: 'automatic', automaticFillSessionId: marker,
    fields: [{ kind: 'username', value: 'synthetic-a' }, { kind: 'password', value: 'synthetic-password' }] }, url, documentId, target).ok).toBe(true);
  discardLoginTargetFill(target);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: () => true });
  const deliver = (username: string) => live!.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, automaticFillSessionId: marker,
    expectedDomain: 'signin.aws.amazon.com', expiresAt: Date.now() + 10_000, form: live!.inspect(url)!,
    values: [{ entryFieldId: 'credential.username', value: username }, { entryFieldId: 'credential.password', value: 'synthetic-password' }] });
  const first = await deliver('synthetic-a'); expect(first.ok).toBe(true); if (!first.ok) return;
  live.cancelDeferred(first.submitReady.pendingId);
  expect(await deliver('synthetic-b')).toEqual({ ok: false, outcome: 'stale-form-map' });
});

it('stops replacement before the second write if the first input handler retargets that field', async () => {
  document.body.innerHTML = '<form id="login"><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form><form id="other"></form>';
  const input = document.querySelector('input')!, password = document.querySelector<HTMLInputElement>('[type=password]')!;
  const target = loginTargetFor(input)!;
  expect(performBoundFill(document, { channel: 'palladin.fill/request', documentId, expectedOrigin: 'https://signin.aws.amazon.com', expectedDomain: 'signin.aws.amazon.com', submit: false, loginTargetId: 'synthetic', intent: 'automatic', automaticFillSessionId: 'a'.repeat(32),
    fields: [{ kind: 'username', value: 'synthetic-a' }, { kind: 'password', value: 'synthetic-a-password' }] }, url, documentId, target).ok).toBe(true);
  discardLoginTargetFill(target);
  input.addEventListener('input', () => password.setAttribute('form', 'other'));
  const writes = vi.fn(); password.addEventListener('input', writes);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: () => true });
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, automaticFillSessionId: 'a'.repeat(32), expectedDomain: 'signin.aws.amazon.com', expiresAt: Date.now() + 10_000, form: live.inspect(url)!,
    values: [{ entryFieldId: 'credential.username', value: 'synthetic-b' }, { entryFieldId: 'credential.password', value: 'synthetic-b-password' }] });
  expect(response).toEqual({ ok: false, outcome: 'stale-form-map' }); expect(writes).not.toHaveBeenCalled();
  expect(input.value).toBe(''); expect(password.value).toBe('synthetic-a-password');
});
