import { describe, expect, it, vi } from 'vitest';
import {
  FEDERATED_SIGNIN_CHANNEL,
  isFederatedSignInResult,
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

function harness(options: { credentials?: Credential[]; metadata?: EntryMetadata[]; unlocked?: boolean; save?: () => Promise<{ action: 'created' | 'updated' }>; vaults?: SignInTargets['vaults'] } = {}) {
  let counter = 0;
  let session = { unlocked: options.unlocked ?? true, generation: 1, profileId: 'profile' };
  const mutedSites = new Set<string>();
  const mute = vi.fn(async (_profile: string, site: string) => { mutedSites.add(site); });
  let now = 1_000;
  const notify = vi.fn();
  const diagnostic = vi.fn();
  const save = vi.fn(options.save ?? (async () => ({ action: 'updated' as const })));
  const targets = vi.fn(async (): Promise<SignInTargets> => ({ writable: true,
    vaults: options.vaults ?? [{ vaultId: 'vault-1', label: 'Personal', isDefault: true }], credentials: options.credentials ?? [] }));
  const coordinator = new FederatedSignInCoordinator({
    getSession: async () => session,
    preferences: { isMuted: async (_profile: string, site: string) => mutedSites.has(site), mute },
    providerAccounts: async () => (options.metadata ?? []).map((entry) => ({ account: entry.username!,
      context: `${entry.name} \u00b7 ${entry.vaultName}`,
      entry: entry.id.startsWith('hidden') ? null : { vaultId: entry.vaultId, entryId: entry.id } })),
    targets,
    localBindings: async () => options.credentials ?? [],
    save,
    isCurrentDocument: async () => true,
    notify,
    diagnostic,
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
    coordinator, notify, save, targets, source, send, prompt, mute, diagnostic,
    lock: () => { session = { ...session, unlocked: false, generation: session.generation + 1 }; coordinator.clear(); },
    advance: (ms: number) => { now += ms; },
  };
}

function googleEntry(username: string, id = `g-${username}`) {
  return { username, urlDomain: 'accounts.google.com', vaultId: 'vault-1', id };
}

function provider(entry: Partial<EntryMetadata> & { id: string; username: string }): EntryMetadata {
  return { vaultId: 'vault-1', vaultName: 'Personal', name: 'Google', type: 1, urlDomain: 'accounts.google.com',
    updatedAt: '2026-10-01T00:00:00Z', ...entry };
}

describe('FederatedSignInCoordinator', () => {
  it.each([1, 2])('offers %s existing targets plus an explicit new alternative and defaults only the sole existing target', async count => {
    const h = harness({ credentials: Array.from({ length: count }, (_, index) => credential(`entry-${index}`, { status: 'absent' })) });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, 'https://app.example.com/callback', undefined);
    const view = (await h.prompt())!;
    expect(view.targets.filter(target => target.action === 'update')).toHaveLength(count);
    expect(view.targets.filter(target => target.action === 'create')).toHaveLength(1);
    expect(view.defaultTargetId).toBe(count === 1 ? view.targets[0]!.id : null);
  });


  it('saves an explicitly chosen new target with the selected provider account despite an existing match', async () => {
    const h = harness({ credentials: [credential('existing', { status: 'absent' })], metadata: [provider({ id: 'g1', username: 'alice@gmail.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, 'https://app.example.com/callback', undefined);
    const view = (await h.prompt())!;
    expect(view.targets.find(target => target.id === view.defaultTargetId)?.action).toBe('update');
    const target = view.targets.find(target => target.action === 'create')!;
    const account = view.accounts.find(account => account.label === 'alice@gmail.com')!;
    expect(await h.send({ type: 'confirm', promptId: view.id, accountId: account.id, targetId: target.id, locale: 'en' })).toMatchObject({ status: 'saved' });
    expect(h.save).toHaveBeenCalledWith('https://app.example.com', { action: 'create', vaultId: 'vault-1' },
      { provider: 'google', account: 'alice@gmail.com', entry: { vaultId: 'vault-1', entryId: 'g1' } }, expect.any(String), expect.any(Function));
  });

  it('saves an account typed in the extension review only through the native manual-account argument', async () => {
    const h = harness({ credentials: [credential('existing', { status: 'absent' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, 'https://app.example.com/callback', undefined);
    const view = (await h.prompt())!;
    const confirm = { channel: FEDERATED_SIGNIN_CHANNEL, documentId: DOC, type: 'confirm' as const, promptId: view.id,
      accountId: 'typed', targetId: view.defaultTargetId!, locale: 'en' as const };
    expect(await h.coordinator.dispatch(confirm, h.source(1))).toEqual({ status: 'stale' });
    expect(h.save).not.toHaveBeenCalled();
    expect(await h.coordinator.dispatch(confirm, h.source(1), undefined, undefined, ' typed@example.com ')).toMatchObject({ status: 'saved' });
    expect(h.save).toHaveBeenCalledWith('https://app.example.com', expect.objectContaining({ action: 'update' }),
      { provider: 'google', account: 'typed@example.com', entry: null }, expect.any(String), expect.any(Function));
  });

  it('defaults to the personal Vault while retaining other writable choices', async () => {
    const h = harness({ vaults: [{ vaultId: 'vault-1', label: 'Personal', isDefault: true },
      { vaultId: 'vault-2', label: 'Team', isDefault: false }] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, 'https://app.example.com/callback?code=c&state=s', undefined);
    const view = (await h.prompt())!;
    expect(view.targets.map((target) => target.vaultLabel)).toEqual(['Personal', 'Team']);
    expect(view.targets.find(target => target.id === view.defaultTargetId)?.vaultLabel).toBe('Personal');
  });

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
      { provider: 'google', account: 'work@corp.com', entry: { vaultId: 'vault-1', entryId: 'g2' } }, 'Metoda logowania', expect.any(Function));
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
    const work: SignInBinding = { provider: 'google', account: 'work@corp.com', entry: null };
    const personal: SignInBinding = { provider: 'google', account: 'alice@gmail.com', entry: null };
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
    h.coordinator.documentConnected(1, 'https://accounts.google.com/v3/signin/identifier?client_id=x', undefined);
    const candidates = [provider({ id: 'g1', username: 'work@corp.com' }), provider({ id: 'g2', username: 'Alice@Gmail.com' })];
    expect(h.coordinator.preferredProviderEntry(1, 'https://accounts.google.com/v3/signin/identifier', candidates)?.id).toBe('g2');
    expect(h.coordinator.preferredProviderEntry(2, 'https://accounts.google.com/v3/signin/identifier', candidates)).toBeNull();
    expect(h.coordinator.preferredProviderEntry(1, 'https://evil.example/o/oauth2', candidates)).toBeNull();

    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();
  });

  it('defaults to the account the user explicitly filled on the provider page but still offers every other choice', async () => {
    const h = harness({ credentials: [credential('e1', { status: 'absent' }, 'first'), credential('e2', { status: 'absent' }, 'second')],
      metadata: [provider({ id: 'g1', username: 'alice@gmail.com' }), provider({ id: 'g2', username: 'work@corp.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier', googleEntry('work@corp.com', 'g2'), 'manual');
    h.coordinator.providerFilled(1, 'https://app.example.com/', googleEntry('ignored@example.com'), 'manual');
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
      binding: { provider: 'google', account: 'work@corp.com', entry: null } })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier', googleEntry('WORK@corp.com'), 'manual');
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();
  });

  it('does not prompt after choosing a remembered provider-only method, but does after switching provider', async () => {
    const h = harness({ credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
      binding: { provider: 'google', account: null, entry: null } })] });
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


  it('preselects an account that only automatic fill used, as a visible suggestion', async () => {
    const h = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier', googleEntry('alice@gmail.com'), 'automatic');
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    expect(view.accounts[0]).toMatchObject({ id: view.defaultAccountId, label: 'alice@gmail.com', source: 'used' });
  });

  it('ignores a Palladin fill of another provider during the flow', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier',
      { username: 'octo', urlDomain: 'github.com', vaultId: 'vault-1', id: 'gh-1' }, 'manual');
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    expect(view.accounts.map((account) => account.label)).toEqual(['']);
  });

  it('does not suppress the prompt when the user switched to another account than the chosen one', async () => {
    const h = harness({ credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
      binding: { provider: 'google', account: 'work@corp.com', entry: null } })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const suggested = await h.send({ type: 'suggest' });
    await h.send({ type: 'choose', suggestionId: suggested.status === 'suggestions' ? suggested.suggestions[0]!.id : '' });
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier', googleEntry('alice@gmail.com'), 'manual');
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    expect(view.accounts.find((account) => account.id === view.defaultAccountId)?.label).toBe('alice@gmail.com');
  });

  it('does not attribute OAuth in a link-opened tab that loaded another site first to its opener', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, 'https://bank.example.com/', undefined);
    h.coordinator.documentConnected(5, 'https://news.example.org/', 1);
    h.coordinator.documentConnected(5, GOOGLE_AUTH, 1);
    h.coordinator.tabRemoved(5);
    expect(await h.prompt(h.source(1, 'https://bank.example.com/'))).toBeNull();
    expect(h.notify).not.toHaveBeenCalledWith(1);
  });

  it('unlinks a popup that browses to an unrelated site and keeps the opener quiet when it closes', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(7, GOOGLE_AUTH, 1);
    h.coordinator.documentConnected(7, 'https://unrelated.example.org/', 1);
    h.coordinator.tabRemoved(7);
    expect(await h.prompt()).toBeNull();
  });

  it('accepts a return to another host of the same registrable domain but writes for the start host', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, 'https://www.example.com/welcome', undefined);
    const from = h.source(1, 'https://www.example.com/welcome');
    const view = (await h.prompt(from))!;
    expect(view.site).toBe('app.example.com');
    await h.send({ type: 'confirm', promptId: view.id, accountId: view.accounts[0]!.id, targetId: view.targets[0]!.id, locale: 'en' }, from);
    expect(h.save).toHaveBeenCalledWith('https://app.example.com', expect.anything(), expect.anything(), 'Sign-in method', expect.any(Function));
  });


  it('links only a discoverable provider Credential and never a hidden one', async () => {
    const h = harness({ metadata: [provider({ id: 'hidden-g1', username: 'private@gmail.com' }), provider({ id: 'g2', username: 'work@corp.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    const hidden = view.accounts.find((account) => account.label === 'private@gmail.com')!;
    await h.send({ type: 'confirm', promptId: view.id, accountId: hidden.id, targetId: view.defaultTargetId!, locale: 'en' });
    expect(h.save).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      { provider: 'google', account: 'private@gmail.com', entry: null }, 'Sign-in method', expect.any(Function));
  });

  it('ranks the exact chosen provider Entry even when two Credentials share the username', async () => {
    const chosenEntry = { vaultId: 'vault-2', entryId: 'g-team' };
    const h = harness({ credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
      binding: { provider: 'google', account: 'shared@corp.com', entry: chosenEntry } })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const suggested = await h.send({ type: 'suggest' });
    await h.send({ type: 'choose', suggestionId: suggested.status === 'suggestions' ? suggested.suggestions[0]!.id : '' });
    h.coordinator.documentConnected(1, 'https://accounts.google.com/v3/signin/identifier?client_id=x', undefined);
    const candidates = [provider({ id: 'g-personal', username: 'shared@corp.com' }),
      provider({ id: 'g-team', vaultId: 'vault-2', username: 'shared@corp.com' })];
    expect(h.coordinator.preferredProviderEntry(1, 'https://accounts.google.com/v3/signin/identifier', candidates)?.id).toBe('g-team');
  });

  it('does not rank a referenced provider Credential whose account changed since it was remembered', async () => {
    const chosenEntry = { vaultId: 'vault-2', entryId: 'g-team' };
    const h = harness({ credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
      binding: { provider: 'google', account: 'alice@corp.com', entry: chosenEntry } })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const suggested = await h.send({ type: 'suggest' });
    await h.send({ type: 'choose', suggestionId: suggested.status === 'suggestions' ? suggested.suggestions[0]!.id : '' });
    h.coordinator.documentConnected(1, 'https://accounts.google.com/v3/signin/identifier?client_id=x', undefined);
    const candidates = [provider({ id: 'g-alice', username: 'alice@corp.com' }),
      provider({ id: 'g-team', vaultId: 'vault-2', username: 'bob@corp.com' })];
    expect(h.coordinator.preferredProviderEntry(1, 'https://accounts.google.com/v3/signin/identifier', candidates)).toBeNull();
  });

  it('returns the same prompt to concurrent refreshes of one document', async () => {
    const h = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const [first, second] = await Promise.all([h.prompt(), h.prompt()]);
    expect(first!.id).toBe(second!.id);
    expect(first!.accounts.map((account) => account.id)).toEqual(second!.accounts.map((account) => account.id));
    expect(h.targets).toHaveBeenCalledTimes(1);
  });

  it('produces a prompt the content guard accepts when a target already has a linked method', async () => {
    const h = harness({ credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
      binding: { provider: 'google', account: 'work@corp.com', entry: { vaultId: 'vault-1', entryId: 'g2' } } })] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, 'https://github.com/login/oauth/authorize?client_id=x', undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const result = await h.send({ type: 'get' });
    expect(isFederatedSignInResult(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('g2');
  });

  it('does not let a generic provider sign-in page establish the provider', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    await h.send({ type: 'intent', provider: 'google' });
    h.coordinator.documentConnected(1, 'https://accounts.google.com/ServiceLogin?continue=https://mail.google.com', undefined);
    h.coordinator.documentConnected(1, 'https://accounts.google.com/AccountChooser', undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();

    h.coordinator.documentConnected(2, SERVICE, undefined);
    h.coordinator.documentConnected(2, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(2, 'https://accounts.google.com/AccountChooser', undefined);
    h.coordinator.documentConnected(2, 'https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize', undefined);
    h.coordinator.documentConnected(2, SERVICE, undefined);
    expect((await h.prompt(h.source(2)))?.provider).toBe('google');
  });

  it('accepts a Google OAuth redirect committed on /v3/signin with the relying party client_id', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, 'https://accounts.google.com/v3/signin/identifier?client_id=x&service=lso', undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect((await h.prompt())?.provider).toBe('google');
  });

  it('keeps same-account Credentials and account-only choices separate', async () => {
    const h = harness({
      credentials: [credential('e1', { status: 'recognized', fieldId: 'custom:x',
        binding: { provider: 'google', account: 'shared@corp.com', entry: null } })],
      metadata: [provider({ id: 'g-personal', username: 'shared@corp.com', name: 'Personal Google' }),
        provider({ id: 'g-team', vaultId: 'vault-2', vaultName: 'Team', username: 'shared@corp.com', name: 'Team Google' })],
    });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const view = (await h.prompt())!;
    const shared = view.accounts.filter((account) => account.label === 'shared@corp.com');
    expect(shared.map((account) => [account.source, account.context])).toEqual([
      ['saved', undefined], ['vault', 'Personal Google \u00b7 Personal'], ['vault', 'Team Google \u00b7 Team']]);
    await h.send({ type: 'confirm', promptId: view.id, accountId: shared[0]!.id, targetId: view.targets[0]!.id, locale: 'en' });
    expect(h.save).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      { provider: 'google', account: 'shared@corp.com', entry: null }, 'Sign-in method', expect.any(Function));
  });

  it('treats generic Google sign-in pages as continuation-only even with a client_id parameter', async () => {
    const h = harness();
    h.coordinator.documentConnected(1, SERVICE, undefined);
    await h.send({ type: 'intent', provider: 'google' });
    h.coordinator.documentConnected(1, 'https://accounts.google.com/ServiceLogin?client_id=x', undefined);
    h.coordinator.documentConnected(1, 'https://accounts.google.com/AccountChooser?client_id=x', undefined);
    h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await h.prompt()).toBeNull();
  });

  it('keeps large prompts within the content guard limits and offers existing matches', async () => {
    const many = Array.from({ length: 70 }, (_, index) => credential(`e${index}`, { status: 'absent' }, `user${index}`));
    const accounts = Array.from({ length: 40 }, (_, index) => provider({ id: `g${index}`, username: `user${index}@gmail.com` }));
    const h = harness({ credentials: many, metadata: accounts });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.providerFilled(1, 'https://accounts.google.com/v3/signin/identifier', googleEntry('user39@gmail.com', 'g39'), 'manual');
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const result = await h.send({ type: 'get' });
    expect(isFederatedSignInResult(result)).toBe(true);
    const view = result.status === 'prompt' ? result.prompt! : null;
    expect(view!.targets.length).toBeLessThanOrEqual(64);
    expect(view!.targets.some((target) => target.action === 'update')).toBe(true);
    expect(view!.targets.some((target) => target.action === 'create')).toBe(true);
    expect(view!.accounts.length).toBeLessThanOrEqual(32);
    expect(view!.accounts.at(-1)!.source).toBe('none');
    expect(view!.accounts.find((account) => account.id === view!.defaultAccountId)?.label).toBe('user39@gmail.com');
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

it('retains manual provider-account provenance after an automatic TOTP fill', async () => {
  const { handleInlineAutofillContentMessage } = await import('../vault/inline-runtime');
  const entry = provider({ id: 'g1', username: 'alice@gmail.com' });
  const h = harness({ metadata: [entry] });
  h.coordinator.documentConnected(1, SERVICE, undefined);
  h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
  const sender = { id: 'ext', frameId: 0, documentId: 'browser-doc', url: 'https://accounts.google.com/signin',
    tab: { id: 1, url: 'https://accounts.google.com/signin' } } as chrome.runtime.MessageSender;
  const deps = { getStatus: async () => 'unlocked' as const, getMetadata: async () => [entry], fill: async () => ({ status: 'filled' as const }),
    signIn: { preferred: () => null, filled: (tabId: number, url: string, filled: EntryMetadata | undefined, intent: 'automatic' | 'manual') => h.coordinator.providerFilled(tabId, url, filled, intent) } };
  const command = { channel: 'palladin.inline-autofill.v1', type: 'inline/fill', documentId: 'a'.repeat(32),
    vaultId: 'vault-1', entryId: 'g1', scope: 'exact', loginTargetId: 'target' };
  await handleInlineAutofillContentMessage(deps, { ...command, intent: 'manual' }, sender, 'ext');
  await handleInlineAutofillContentMessage(deps, { ...command, intent: 'automatic', purpose: 'totp' }, sender, 'ext');
  h.coordinator.documentConnected(1, SERVICE, undefined);
  const prompt = (await h.prompt())!;
  expect(prompt.accounts.find(account => account.id === prompt.defaultAccountId)?.label).toBe('alice@gmail.com');
});

it.each(['live','other-document','locked'])('persists OAuth site mute only from the authorized prompt (%s)', async state => {
  const h = harness();
  const round = () => { h.coordinator.documentConnected(1,SERVICE,undefined); h.coordinator.documentConnected(1,GOOGLE_AUTH,undefined); h.coordinator.documentConnected(1,SERVICE,undefined); };
  round(); const view = (await h.prompt())!;
  if(state==='locked')h.lock();
  const from = state==='other-document' ? h.source(1,SERVICE,'foreign-document') : h.source(1);
  expect(await h.send({type:'mute',promptId:view.id},from)).toEqual({status:state==='live'?'dismissed':'stale'});
  if(state==='live') { expect(h.mute).toHaveBeenCalledWith('profile','example.com'); round(); expect(await h.prompt()).toBeNull(); }
  else expect(h.mute).not.toHaveBeenCalled();
});

describe('observed and preselected provider accounts', () => {
  const PAGE = 'https://accounts.google.com/v3/signin/identifier';
  const start = (h: ReturnType<typeof harness>) => { h.coordinator.documentConnected(1, SERVICE, undefined); h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined); };
  const back = async (h: ReturnType<typeof harness>) => { h.coordinator.documentConnected(1, 'https://app.example.com/callback', undefined); return (await h.prompt())!; };
  const selected = (view: SignInPrompt) => view.accounts.find(item => item.id === view.defaultAccountId);
  const observe = (h: ReturnType<typeof harness>, account: string, url = PAGE, tab = 1) => h.send({ type: 'account', account }, h.source(tab, url));

  it('preselects an observed account and links its only saved Credential', async () => {
    const h = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' }), provider({ id: 'g2', username: 'zoe@gmail.com' })] });
    start(h); expect(await observe(h, 'ZOE@gmail.com')).toEqual({ status: 'accepted' });
    const view = await back(h);
    expect(selected(view)).toMatchObject({ label: 'zoe@gmail.com', source: 'observed' });
    await h.send({ type: 'confirm', promptId: view.id, accountId: view.defaultAccountId!, targetId: view.defaultTargetId!, locale: 'en' });
    expect(h.save.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ account: 'zoe@gmail.com', entry: { vaultId: 'vault-1', entryId: 'g2' } })]));
  });
  it('keeps an observed account without an Entry link when Credentials are ambiguous or absent', async () => {
    for (const metadata of [[], [provider({ id: 'g1', username: 'zoe@gmail.com' }), provider({ id: 'g2', username: 'zoe@gmail.com' })]]) {
      const h = harness({ metadata }); start(h); await observe(h, 'zoe@gmail.com');
      const view = await back(h);
      expect(selected(view)).toEqual({ id: view.defaultAccountId, label: 'zoe@gmail.com', source: 'observed' });
    }
  });
  it('prefers the observed account over an earlier choice or fill and lets the last observation win', async () => {
    const h = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' })] });
    start(h); h.coordinator.providerFilled(1, PAGE, googleEntry('alice@gmail.com', 'g1'), 'manual');
    await observe(h, 'first@gmail.com'); await observe(h, 'last@gmail.com');
    expect(selected(await back(h))?.label).toBe('last@gmail.com');
  });
  it('asks again when the observed account differs from the chosen remembered one', async () => {
    const h = harness({ credentials: [credential('e', { status: 'recognized', fieldId: 'custom:1', binding: { provider: 'google', account: 'alice@gmail.com', entry: null } } as Credential['signIn'])] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const list = await h.send({ type: 'suggest' });
    if (list.status !== 'suggestions') throw new Error('suggestions');
    await h.send({ type: 'choose', suggestionId: list.suggestions[0]!.id });
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    await observe(h, 'other@gmail.com');
    expect(selected(await back(h))?.label).toBe('other@gmail.com');
  });
  it('still asks for an observed account that matches a remembered binding, because the final account is unconfirmed', async () => {
    const h = harness({ credentials: [credential('e', { status: 'recognized', fieldId: 'custom:1', binding: { provider: 'google', account: 'alice@gmail.com', entry: null } } as Credential['signIn'])] });
    start(h); await observe(h, 'alice@gmail.com');
    const view = await back(h);
    expect(selected(view)).toMatchObject({ label: 'alice@gmail.com', source: 'observed' });
    expect(view?.notice?.detail).toBe('');
  });
  it('accepts an observation in the popup linked to the service tab', async () => {
    const h = harness(); h.coordinator.documentConnected(1, SERVICE, undefined);
    h.coordinator.documentConnected(2, GOOGLE_AUTH, 1);
    await observe(h, 'pop@gmail.com', PAGE, 2); h.coordinator.tabRemoved(2);
    expect(selected((await h.prompt())!)?.label).toBe('pop@gmail.com');
  });
  it.each(['https://evil.example/', 'https://github.com/login', 'https://accounts.google.com:8443/', 'http://accounts.google.com/'])('rejects an observation from %s', async url => {
    const h = harness(); start(h);
    expect(await observe(h, 'x@gmail.com', url)).toEqual({ status: 'stale' });
    expect(selected(await back(h))).toBeUndefined();
  });
  it('rejects an observation without a provider flow, from another tab, while locked or after return', async () => {
    const h = harness(); h.coordinator.documentConnected(1, SERVICE, undefined);
    expect(await observe(h, 'x@gmail.com')).toEqual({ status: 'stale' });
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    expect(await observe(h, 'x@gmail.com', PAGE, 7)).toEqual({ status: 'stale' });
    const view = await back(h); expect(selected(view)).toBeUndefined();
    expect(await observe(h, 'x@gmail.com')).toEqual({ status: 'stale' });
    const locked = harness({ unlocked: false }); start(locked);
    expect(await observe(locked, 'x@gmail.com')).toEqual({ status: 'stale' });
  });
  it('drops an observation when the flow switches provider', async () => {
    const h = harness(); start(h); await observe(h, 'x@gmail.com');
    h.coordinator.documentConnected(1, 'https://github.com/login/oauth/authorize?client_id=x', undefined);
    const view = await back(h);
    expect(view.provider).toBe('github'); expect(view.accounts.map(item => item.label)).not.toContain('x@gmail.com');
  });
  it('preselects the sole saved provider account but never guesses between several', async () => {
    const one = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' })] }); start(one);
    const guessed = await back(one);
    expect(selected(guessed)?.label).toBe('alice@gmail.com');
    expect(guessed.notice?.detail).toBe('');
    const two = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' }), provider({ id: 'g2', username: 'zoe@gmail.com' })] }); start(two);
    expect((await back(two)).defaultAccountId).toBeNull();
  });
  it('does not treat a guessed account as proof that it is already remembered', async () => {
    const h = harness({ metadata: [provider({ id: 'g1', username: 'alice@gmail.com' })],
      credentials: [credential('e', { status: 'recognized', fieldId: 'custom:1', binding: { provider: 'google', account: 'alice@gmail.com', entry: null } } as Credential['signIn'])] });
    start(h); expect(await back(h)).not.toBeNull();
  });
  it('offers saved accounts beyond the former alphabetical limit of ten', async () => {
    const h = harness({ metadata: Array.from({ length: 25 }, (_, i) => provider({ id: `g${i}`, username: `user${String(i).padStart(2, '0')}@gmail.com` })) });
    start(h); expect((await back(h)).accounts.map(item => item.label)).toContain('user24@gmail.com');
  });
});

describe('sign-in compatibility diagnostics', () => {
  const PAGE = 'https://accounts.google.com/v3/signin/accountchooser';
  const shape = { kind: 'account-chooser' as const, identifierField: false, passwordField: false, emailAttribute: true, emailText: true };
  const start = (h: ReturnType<typeof harness>) => { h.coordinator.documentConnected(1, SERVICE, undefined); h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined); };
  const back = async (h: ReturnType<typeof harness>) => { h.coordinator.documentConnected(1, 'https://app.example.com/callback', undefined); return h.prompt(); };

  it('reports once per flow when the account was not read, with the last provider screen shape', async () => {
    const h = harness();
    start(h);
    expect(await h.send({ type: 'screen', screen: shape }, h.source(1, PAGE))).toEqual({ status: 'accepted' });
    await back(h); await h.prompt();
    expect(h.diagnostic).toHaveBeenCalledTimes(1);
    expect(h.diagnostic).toHaveBeenCalledWith({ event: 'account-not-observed', serviceUrl: 'https://app.example.com', provider: 'google', providerUrl: PAGE, screen: shape });
  });

  it('reports no provider screen when none was seen and nothing when the account was read', async () => {
    const silent = harness(); start(silent); await back(silent);
    expect(silent.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'account-not-observed', providerUrl: null, screen: null }));
    const read = harness(); start(read);
    await read.send({ type: 'account', account: 'alice@gmail.com' }, read.source(1, 'https://accounts.google.com/v3/signin/identifier'));
    await back(read);
    expect(read.diagnostic).not.toHaveBeenCalled();
  });

  it('reports an unread account even when the remembered method suppresses the prompt', async () => {
    const h = harness({ credentials: [credential('e', { status: 'recognized', fieldId: 'custom:1', binding: { provider: 'google', account: null, entry: null } } as Credential['signIn'])] });
    h.coordinator.documentConnected(1, SERVICE, undefined);
    const suggestion = await h.send({ type: 'suggest' });
    const id = suggestion.status === 'suggestions' ? suggestion.suggestions[0]?.id : undefined;
    expect(id).toBeDefined();
    await h.send({ type: 'choose', suggestionId: id! });
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    expect(await back(h)).toBeNull();
    expect(h.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'account-not-observed', provider: 'google' }));
  });

  it('accepts a screen shape only from a provider sign-in page in an active flow', async () => {
    const h = harness();
    expect(await h.send({ type: 'screen', screen: shape }, h.source(1, PAGE))).toEqual({ status: 'stale' });
    start(h);
    expect(await h.send({ type: 'screen', screen: shape }, h.source(1, 'https://evil.example/'))).toEqual({ status: 'stale' });
  });

  it('reports an OAuth authorization request to an unsupported provider but not a supported one or an ordinary page', () => {
    const h = harness();
    h.coordinator.documentConnected(1, 'https://acme.okta.com/oauth2/v1/authorize?client_id=c&redirect_uri=https%3A%2F%2Fapp.example.com&response_type=code&state=s', undefined);
    h.coordinator.documentConnected(1, GOOGLE_AUTH, undefined);
    h.coordinator.documentConnected(1, 'https://shop.example.com/search?client_id=c', undefined);
    expect(h.diagnostic.mock.calls).toEqual([[{ event: 'provider-unsupported',
      authorizationUrl: 'https://acme.okta.com/oauth2/v1/authorize?client_id=c&redirect_uri=https%3A%2F%2Fapp.example.com&response_type=code&state=s' }]]);
  });
});
