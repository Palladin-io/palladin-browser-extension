import { describe, expect, it, vi } from 'vitest';
import {
  FEDERATED_SIGNIN_CHANNEL,
  type FederatedSignInCommand,
  type SignInPrompt,
} from '@shared/messaging/federated-signin';
import type { SignInBinding } from '@shared/signin/binding';
import type { EntryMetadata } from '../vault/entry-metadata';
import type { SignInTargets } from '../vault/protocol2/credential-writer';
import { FederatedSignInCoordinator, type SignInSource } from './coordinator';

const SERVICE = 'https://app.example.com/login';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=s1&nonce=n1';
const DOC = 'document-aaaaaaaaaaaaaaaa';

type Credential = SignInTargets['credentials'][number];
type CommandBody = FederatedSignInCommand extends infer C ? C extends FederatedSignInCommand ? Omit<C, 'channel' | 'documentId'> : never : never;

function credential(entryId: string, signIn: Credential['signIn'], username = ''): Credential {
  return { vaultId: 'vault-1', entryId, revision: '3', label: `Example ${entryId}`, username, vaultLabel: 'Personal', signIn };
}

function harness(options: { credentials?: Credential[]; metadata?: EntryMetadata[]; unlocked?: boolean; save?: () => Promise<{ action: 'created' | 'updated' }> } = {}) {
  let counter = 0;
  let session = { unlocked: options.unlocked ?? true, generation: 1 };
  let now = 1_000;
  const notify = vi.fn();
  const save = vi.fn(options.save ?? (async () => ({ action: 'updated' as const })));
  const targets = vi.fn(async (): Promise<SignInTargets> => ({ writable: true,
    vaults: [{ vaultId: 'vault-1', label: 'Personal', isDefault: true }], credentials: options.credentials ?? [] }));
  const coordinator = new FederatedSignInCoordinator({
    getSession: async () => session,
    metadata: async () => options.metadata ?? [],
    targets,
    save,
    isCurrentDocument: async () => true,
    notify,
    now: () => now,
    createId: () => `opaque-id-${String(++counter).padStart(8, '0')}`,
  });
  const source = (tabId: number, url = SERVICE, documentId = DOC): SignInSource =>
    ({ tabId, browserDocumentId: `browser-${tabId}`, documentId, url });
  const send = (command: CommandBody, from = source(1)) =>
    coordinator.dispatch({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: from.documentId, ...command } as FederatedSignInCommand, from);
  const prompt = async (from = source(1)): Promise<SignInPrompt | null> => {
    const result = await send({ type: 'get' }, from);
    return result.status === 'prompt' ? result.prompt : null;
  };
  return {
    coordinator, notify, save, targets, source, send, prompt,
    lock: () => { session = { unlocked: false, generation: session.generation + 1 }; coordinator.clear(); },
    advance: (ms: number) => { now += ms; },
  };
}

function provider(entry: Partial<EntryMetadata> & { id: string; username: string }): EntryMetadata {
  return { vaultId: 'vault-1', vaultName: 'Personal', name: 'Google', type: 1, urlDomain: 'accounts.google.com',
    updatedAt: '2026-10-01T00:00:00Z', ...entry };
}

describe('FederatedSignInCoordinator', () => {
  it('asks only after a same-tab provider round trip and saves the explicit choice', async () => {
    const h = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' }), provider({ id: 'g2', username: 'work@corp.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    expect(await h.prompt()).toBeNull();
    h.coordinator.documentConnected(1, 'https://app.example.com/callback?code=secret-code&state=s1', undefined);
    expect(h.notify).toHaveBeenCalledWith(1);

    const view = (await h.prompt())!;
    expect(view).toMatchObject({ site: 'app.example.com', provider: 'google', state: 'ready', defaultAccountId: null });
    expect(view.accounts.map((account) => [account.label, account.source])).toEqual([
      ['alice@gmail.com', 'vault'], ['work@corp.com', 'vault'], ['', 'none'],
    ]);
    expect(JSON.stringify(view)).not.toContain('secret-code');
    const work = view.accounts.find((account) => account.label === 'work@corp.com')!;
    const result = await h.send({ type: 'confirm', promptId: view.id, accountId: work.id, targetId: view.defaultTargetId!, locale: 'pl' });
    expect(result).toEqual({ status: 'saved', action: 'updated' });
    expect(h.save).toHaveBeenCalledWith('https://app.example.com', { action: 'create', vaultId: 'vault-1' },
      { provider: 'google', account: 'work@corp.com' }, 'Metoda logowania', expect.any(Function));
    expect(await h.prompt()).toBeNull();
  });

  it('links a popup through its opener and prompts in the service tab when the popup closes', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    await h.send({ type: 'intent', provider: 'apple' });
    h.coordinator.documentConnected(7, 'https://appleid.apple.com/auth/authorize?client_id=x', 1);
    expect(await h.prompt()).toBeNull();
    h.coordinator.tabRemoved(7);
    expect(h.notify).toHaveBeenCalledWith(1);
    expect((await h.prompt())?.provider).toBe('apple');
  });

  it('treats an OAuth error return as cancellation in the tab and in a popup', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, 'https://app.example.com/callback?error=access_denied&state=s1', undefined);
    expect(await h.prompt()).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();

    h.coordinator.documentConnected(2, SERVICE, undefined);
    h.coordinator.documentConnected(9, 'https://github.com/login/oauth/authorize?client_id=x', 2);
    h.coordinator.documentConnected(9, 'https://app.example.com/cb#error=user_cancelled', 2);
    h.coordinator.tabRemoved(9);
    expect(await h.prompt(h.source(2))).toBeNull();
  });

  it('never starts from the provider own sign-in page without an explicit intent', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, 'https://news.example.org/', undefined);
    h.coordinator.documentConnected(1, 'https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com', undefined);
    h.coordinator.documentConnected(1, 'https://news.example.org/', undefined);
    expect(await h.prompt(h.source(1, 'https://news.example.org/'))).toBeNull();
  });

  it('ignores lookalike provider hosts and does not cross to another service origin', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    await h.send({ type: 'intent', provider: 'google' });
    h.coordinator.documentConnected(1, 'https://accounts-google.example.net/o/oauth2/v2/auth?client_id=x', undefined);
    h.coordinator.documentConnected(1, 'https://app.example.com/home', undefined);
    expect(await h.prompt(h.source(1, 'https://app.example.com/home'))).toBeNull();

    h.coordinator.documentConnected(2, SERVICE, undefined);
    h.coordinator.documentConnected(2, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(2, 'https://phish.example.net/cb', undefined);
    expect(await h.prompt(h.source(2, 'https://phish.example.net/cb'))).toBeNull();
    h.coordinator.documentConnected(2, 'https://app.example.com/home', undefined);
    expect(await h.prompt(h.source(2, 'https://phish.example.net/cb'))).toBeNull();
    expect((await h.prompt(h.source(2, 'https://app.example.com/home')))?.provider).toBe('google');
  });

  it('keeps parallel tabs independent', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(2, 'https://other.example.org/login', undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(2, 'https://github.com/login/oauth/authorize?client_id=y', undefined);
    h.coordinator.documentConnected(2, 'https://other.example.org/dashboard', undefined);
    expect(await h.prompt(h.source(1))).toBeNull();
    expect((await h.prompt(h.source(2, 'https://other.example.org/dashboard')))?.provider).toBe('github');
    h.coordinator.documentConnected(1, 'https://app.example.com/home', undefined);
    expect((await h.prompt(h.source(1, 'https://app.example.com/home')))?.provider).toBe('google');
  });

  it('shows a locked prompt without accounts and forgets everything on lock', async () => {
    const h = harness({ unlocked: false, metadata: [provider({ id: 'g1', username: 'alice@gmail.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toMatchObject({ state: 'locked', accounts: [], targets: [] });
    h.lock();
    expect(await h.prompt()).toBeNull();
  });

  it('expires flows after ten minutes', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.advance(10 * 60_000 + 1);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();
  });

  it('suggests every remembered account for the host and requires an explicit choice', async () => {
    const work: SignInBinding = { provider: 'google', account: 'work@corp.com' };
    const personal: SignInBinding = { provider: 'google', account: 'alice@gmail.com' };
    const h = harness({ credentials: [
      credential('e1', { status: 'recognized', binding: work, fieldId: 'custom:x' }),
      credential('e2', { status: 'recognized', binding: personal, fieldId: 'custom:y' }),
      credential('e3', { status: 'unrecognized' }),
    ] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const suggested = await h.send({ type: 'suggest' });
    expect(suggested.status).toBe('suggestions');
    const items = suggested.status === 'suggestions' ? suggested.suggestions : [];
    expect(items.map((item) => item.account)).toEqual(['work@corp.com', 'alice@gmail.com']);

    expect(await h.send({ type: 'choose', suggestionId: items[1]!.id }, h.source(2))).toEqual({ status: 'stale' });
    expect(await h.send({ type: 'choose', suggestionId: items[1]!.id })).toEqual({ status: 'chosen', provider: 'google' });
    h.coordinator.documentConnected(1, 'https://accounts.google.com/v3/signin/identifier?x=1', undefined);
    const candidates = [provider({ id: 'g1', username: 'work@corp.com' }), provider({ id: 'g2', username: 'Alice@Gmail.com' })];
    expect(h.coordinator.preferredProviderEntry(1, 'https://accounts.google.com/v3/signin/identifier', candidates)?.id).toBe('g2');
    expect(h.coordinator.preferredProviderEntry(2, 'https://accounts.google.com/v3/signin/identifier', candidates)).toBeNull();
    expect(h.coordinator.preferredProviderEntry(1, 'https://evil.example/o/oauth2', candidates)).toBeNull();

    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();
  });

  it('defaults to the account Palladin filled on the provider page but still offers every other choice', async () => {
    const h = harness({ credentials: [credential('e1', { status: 'absent' }, 'first'), credential('e2', { status: 'absent' }, 'second')],
      metadata: [provider({ id: 'g1', username: 'alice@gmail.com' }), provider({ id: 'g2', username: 'work@corp.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier', 'work@corp.com');
    h.coordinator.providerFilled(1, 'https://app.example.com/', 'ignored@example.com');
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    const defaultAccount = view.accounts.find((account) => account.id === view.defaultAccountId);
    expect(defaultAccount).toMatchObject({ label: 'work@corp.com', source: 'used' });
    expect(view.accounts.map((account) => account.label)).toEqual(['work@corp.com', 'alice@gmail.com', '']);
    expect(view.targets.filter((target) => target.action === 'update').map((target) => target.label))
      .toEqual(['Example e1 (first)', 'Example e2 (second)']);
    expect(view.defaultTargetId).toBeNull();
  });

  it('does not prompt again when the exact provider account is already remembered', async () => {
    const h = harness({ credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
      binding: { provider: 'google', account: 'work@corp.com' } })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier', 'WORK@corp.com');
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();
  });

  it('does not prompt after choosing a remembered provider-only method, but does after switching provider', async () => {
    const h = harness({ credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
      binding: { provider: 'google', account: null } })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const suggested = await h.send({ type: 'suggest' });
    const id = suggested.status === 'suggestions' ? suggested.suggestions[0]!.id : '';
    await h.send({ type: 'choose', suggestionId: id });
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();

    await h.send({ type: 'choose', suggestionId: id });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    await h.send({ type: 'suggest' }).then(async (result) => {
      const next = result.status === 'suggestions' ? result.suggestions[0]!.id : '';
      await h.send({ type: 'choose', suggestionId: next });
    });
    h.coordinator.documentConnected(1, 'https://github.com/login/oauth/authorize?client_id=x', undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect((await h.prompt())?.provider).toBe('github');
  });

  it('rejects forged, stale and cross-document confirmations', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    const account = view.accounts[0]!.id;
    expect(await h.send({ type: 'confirm', promptId: view.id, accountId: 'forged-account-id-0000', targetId: view.targets[0]!.id, locale: 'en' }))
      .toEqual({ status: 'stale' });
    expect(await h.send({ type: 'confirm', promptId: view.id, accountId: account, targetId: view.targets[0]!.id, locale: 'en' },
      { ...h.source(1), browserDocumentId: 'browser-other' })).toEqual({ status: 'stale' });
    expect(await h.send({ type: 'confirm', promptId: view.id, accountId: account, targetId: view.targets[0]!.id, locale: 'en' },
      h.source(1, 'https://evil.example.net/'))).toEqual({ status: 'stale' });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('rebuilds the prompt with an error after a failed write', async () => {
    const h = harness({ save: async () => { throw new Error('conflict'); } });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    const result = await h.send({ type: 'confirm', promptId: view.id, accountId: view.accounts[0]!.id, targetId: view.targets[0]!.id, locale: 'en' });
    expect(result.status).toBe('prompt');
    expect(result.status === 'prompt' && result.prompt?.error).toBe('save-failed');
    expect(result.status === 'prompt' && result.prompt?.id).not.toBe(view.id);
  });

  it('Not now mutes the host until lock', async () => {
    const h = harness();
    const round = () => {
      h.coordinator.documentConnected(1, SERVICE, undefined);
      h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
      h.coordinator.documentConnected(1, SERVICE, undefined);
    };
    round();
    const view = (await h.prompt())!;
    expect(await h.send({ type: 'dismiss', promptId: view.id })).toEqual({ status: 'dismissed' });
    round();
    expect(await h.prompt()).toBeNull();
    h.lock();
    round();
    expect((await h.prompt())?.state).toBe('locked');
  });
});
