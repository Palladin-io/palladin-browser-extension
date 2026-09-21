// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';

// Synthetic mechanism regression only. These handlers demonstrate queued form
// state; they are not a capture of LinkedIn's markup or production JavaScript.
const url = 'https://login.example.test/login';
const documentId = 'd'.repeat(32);
let live: LiveLogin | undefined;
afterEach(() => { live?.clear(); document.body.replaceChildren(); });

it.each([['microtask', 'form'], ['timer', 'form'], ['microtask', 'div'], ['timer', 'div']] as const)('allows %s input state in %s scope to settle before the first physical submit', async (scheduler, scope) => {
  document.body.innerHTML = `<${scope}><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></${scope}>`;
  const username = document.querySelector<HTMLInputElement>('input[autocomplete=username]')!;
  const password = document.querySelector<HTMLInputElement>('input[type=password]')!;
  let frameworkUsername = '', frameworkPassword = '';
  const scheduled: Promise<void>[] = [];
  for (const input of [username, password]) {
    input.addEventListener('input', () => {
      const next = input.value;
      scheduled.push(new Promise<void>(resolve => {
        const flush = () => {
          if (input === username) frameworkUsername = next;
          else frameworkPassword = next;
          resolve();
        };
        if (scheduler === 'microtask') queueMicrotask(flush);
        else setTimeout(flush, 0);
      }));
    });
  }
  const accepted: boolean[] = [];
  document.querySelector('button')!.addEventListener('click', event => {
    event.preventDefault();
    accepted.push(frameworkUsername === 'synthetic-user' && frameworkPassword === 'Synthetic-password!42');
  });
  live = new LiveLogin(document, documentId, () => url, () => true,
    { isVisible: element => !element.hidden && !element.closest('[hidden]') });
  const plan = live.inspect(url);
  expect(plan?.version).toBe(2);
  expect(plan?.steps[0]?.fields.map(field => field.entryFieldId))
    .toEqual(['credential.username', 'credential.password']);
  const ready = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test',
    expiresAt: Date.now() + 10_000, form: plan!, values: [
      { entryFieldId: 'credential.username', value: 'synthetic-user' },
      { entryFieldId: 'credential.password', value: 'Synthetic-password!42' },
    ] });
  expect(ready.ok).toBe(true); if (!ready.ok) return;
  expect(accepted).toEqual([]);
  expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 })).toEqual({ ok: true });
  expect(username.value).toBe('synthetic-user');
  expect(password.value).toBe('Synthetic-password!42');
  await Promise.all(scheduled);
  expect(accepted).toHaveLength(1);
  expect(accepted[0], 'The first submit must see the queued input state too').toBe(true);
});

it.each(['', 'foreign', 'synthetic-user'])('preserves an editable carried username only when already matching: %s', async existing => {
  document.body.innerHTML = '<div><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></div>';
  const username = document.querySelector<HTMLInputElement>('input')!; username.value = existing;
  const events = vi.fn(); username.addEventListener('input', events); username.addEventListener('change', events);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: () => true });
  const plan = live.inspect(url)!;
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test',
    expiresAt: Date.now() + 10_000, requireExistingUsername: true, form: plan,
    values: [{ entryFieldId: 'credential.username', value: 'synthetic-user' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(response.ok).toBe(existing === 'synthetic-user'); expect(username.value).toBe(existing); expect(events).not.toHaveBeenCalled();
  if (response.ok) live.cancelDeferred(response.submitReady.pendingId);
});
it.each(['disabled', 'readonly'])('includes an existing %s identity in a normal password form with a native action', async attribute => {
  document.body.innerHTML = `<form><input autocomplete="username" ${attribute}><input type="password" autocomplete="current-password"><button>Sign in</button></form>`;
  const username = document.querySelector<HTMLInputElement>('input')!; username.value = 'foreign';
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => !element.hidden });
  const plan = live.inspect(url)!;
  expect(plan.steps[0]!.fields.map(field => field.entryFieldId)).toEqual(['credential.username', 'credential.password']);
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: plan, values: [{ entryFieldId: 'credential.username', value: 'synthetic-user' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(response.ok).toBe(false); expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe(''); expect(username.value).toBe('foreign');
});
it.each(['unchanged', 'value', 'duplicate', 'replacement', 'mode'])('revalidates an existing normal-form readonly identity through commit: %s', async mutation => {
  document.body.innerHTML = '<form><input autocomplete="username" readonly><input type="password" autocomplete="current-password"><button>Sign in</button></form>';
  const username = document.querySelector<HTMLInputElement>('input')!; username.value = 'synthetic-user';
  const events = vi.fn(), clicked = vi.fn((event: Event) => event.preventDefault()); username.addEventListener('input', events); username.addEventListener('change', events);
  document.querySelector('button')!.addEventListener('click', clicked);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => !element.hidden });
  const ready = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: live.inspect(url)!, values: [{ entryFieldId: 'credential.username', value: 'synthetic-user' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(ready.ok).toBe(true); if (!ready.ok) return;
  if (mutation === 'value') username.value = 'foreign';
  if (mutation === 'duplicate') username.after(username.cloneNode(true));
  if (mutation === 'replacement') username.replaceWith(username.cloneNode(true));
  if (mutation === 'mode') username.readOnly = false;
  expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(mutation === 'unchanged');
  expect(clicked).toHaveBeenCalledTimes(mutation === 'unchanged' ? 1 : 0); expect(events).not.toHaveBeenCalled();
});
it.each(['identity', 'destination', 'replacement'])('revalidates queued %s mutation before returning submit-ready', async mutation => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>';
  const username = document.querySelector<HTMLInputElement>('input')!, password = document.querySelector<HTMLInputElement>('input[type=password]')!;
  const clicked = vi.fn(); document.querySelector('button')!.addEventListener('click', clicked);
  password.addEventListener('input', () => setTimeout(() => {
    if (mutation === 'identity') username.value = 'foreign';
    if (mutation === 'destination') document.querySelector('form')!.action = 'https://foreign.example.test/';
    if (mutation === 'replacement') password.replaceWith(password.cloneNode(true));
  }, 0));
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: () => true });
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: live.inspect(url)!, values: [{ entryFieldId: 'credential.username', value: 'synthetic-user' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(response.ok).toBe(false); expect(clicked).not.toHaveBeenCalled();
  expect(username.value).toBe(mutation === 'identity' ? 'foreign' : '');
  if (mutation !== 'replacement') expect(password.value).toBe('');
});
it('does not release the password when the first input handler changes the approved username', async () => {
  document.body.innerHTML = '<div><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></div>';
  const username = document.querySelector<HTMLInputElement>('input')!, password = document.querySelector<HTMLInputElement>('input[type=password]')!, written = vi.fn();
  username.addEventListener('input', () => { username.value = 'foreign'; }); password.addEventListener('input', written);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: () => true });
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: live.inspect(url)!, values: [{ entryFieldId: 'credential.username', value: 'synthetic-user' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(response.ok).toBe(false); expect(written).not.toHaveBeenCalled(); expect(password.value).toBe(''); expect(username.value).toBe('foreign');
});
it.each(['Authenticate', 'Verify code', 'Potwierdź'])('retains the normal discovery action vocabulary: %s', async caption => {
  document.body.innerHTML = `<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>${caption}</button></form>`;
  const clicked = vi.fn((event: Event) => event.preventDefault()); document.querySelector('button')!.addEventListener('click', clicked);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => !element.hidden });
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: live.inspect(url)!, values: [{ entryFieldId: 'credential.username', value: 'synthetic-user' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(response.ok).toBe(true); if (!response.ok) return;
  expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: response.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(true);
  expect(clicked).toHaveBeenCalledTimes(1);
});
it.each(['ambiguous', 'hidden', 'mode'])('revalidates the original known action and field modes before commit: %s', async mutation => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Authenticate</button></form>';
  const clicked = vi.fn(); document.querySelector('button')!.addEventListener('click', clicked);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => !element.hidden });
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: live.inspect(url)!, values: [{ entryFieldId: 'credential.username', value: 'synthetic-user' }, { entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(response.ok).toBe(true); if (!response.ok) return;
  if (mutation === 'ambiguous') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<button>Sign in</button>');
  if (mutation === 'hidden') document.querySelector('button')!.hidden = true;
  if (mutation === 'mode') document.querySelector('input')!.readOnly = true;
  expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: response.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
});
// Synthetic normal forms: non-credential readonly emails must not become a
// carried identity merely because their native input type is email.
it.each(['readonly', 'disabled'])('ignores %s subscription and confirmation emails in a normal password-only stage', async mode => {
  document.body.innerHTML = `<form><input type="email" name="newsletter_email" ${mode}><input type="email" aria-label="Confirm email" ${mode}><input type="password" autocomplete="current-password"><button>Sign in</button></form>`;
  const emails = [...document.querySelectorAll<HTMLInputElement>('input[type=email]')];
  emails[0]!.value = 'unrelated@example.test';
  const changed = vi.fn(), clicked = vi.fn((event: Event) => event.preventDefault());
  for (const email of emails) { email.addEventListener('input', changed); email.addEventListener('change', changed); }
  document.querySelector('button')!.addEventListener('click', clicked);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => !element.hidden });
  const plan = live.inspect(url);
  expect(plan?.steps[0]!.fields.map(field => field.entryFieldId)).toEqual(['credential.password']);
  const ready = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: plan!, values: [{ entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(ready.ok).toBe(true); if (!ready.ok) return;
  expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(true);
  expect(clicked).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled();
  expect(emails.map(email => email.value)).toEqual(['unrelated@example.test', '']);
});
it('blocks a formerly unrelated readonly email reclassified as carried identity before commit', async () => {
  document.body.innerHTML = '<form><input type="email" name="newsletter_email" readonly><input type="password" autocomplete="current-password"><button>Sign in</button></form>';
  const clicked = vi.fn(); document.querySelector('button')!.addEventListener('click', clicked);
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => !element.hidden });
  const plan = live.inspect(url);
  expect(plan?.steps[0]!.fields.map(field => field.entryFieldId)).toEqual(['credential.password']);
  const ready = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test', expiresAt: Date.now() + 10_000,
    form: plan!, values: [{ entryFieldId: 'credential.password', value: 'Synthetic-password!42' }] });
  expect(ready.ok).toBe(true); if (!ready.ok) return;
  document.querySelector<HTMLInputElement>('input[type=email]')!.name = 'username';
  expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(clicked).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('');
});
