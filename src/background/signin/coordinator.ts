import type {
  FederatedSignInCommand,
  FederatedSignInResult,
  SignInAccountOption,
  SignInAccountSource,
  SignInLocale,
  SignInPrompt,
  SignInTargetOption,
} from '@shared/messaging/federated-signin';
import { MAX_SIGN_IN_PROMPT_ACCOUNTS, MAX_SIGN_IN_PROMPT_TARGETS } from '@shared/messaging/federated-signin';
import { registrableDomain } from '@shared/security/domain';
import {
  normalizeSignInAccount, sameSignInAccount, sameSignInEntry, type SignInBinding, type SignInEntryReference,
} from '@shared/signin/binding';
import {
  classifyProviderUrl,
  isAuthorizationErrorReturn,
  isProviderSignInHost,
  SIGN_IN_PROVIDER_ACCOUNT_DOMAINS,
  type ProviderPage,
  type SignInProvider,
} from '@shared/signin/providers';
import type { EntryMetadata } from '../vault/entry-metadata';
import type { SignInTargets, SignInWriteTarget } from '../vault/protocol2/credential-writer';

const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 20;
const MAX_VAULT_ACCOUNTS = 10;
const MAX_CREATE_TARGETS = 8;

export interface SignInSource {
  readonly tabId: number;
  readonly browserDocumentId: string;
  readonly documentId: string;
  readonly url: string;
}

export interface ProviderAccount {
  readonly account: string;
  readonly entry: SignInEntryReference | null;
  /** Entry name and Vault label shown so the user can tell same-account Credentials apart. */
  readonly context: string;
}

export interface SignInSession {
  readonly unlocked: boolean;
  readonly generation: number;
}

export interface FederatedSignInDeps {
  getSession(): Promise<SignInSession | null>;
  /** Provider Credentials from the local cache; `entry` is set only for discoverable ones. */
  providerAccounts(provider: SignInProvider): Promise<ProviderAccount[]>;
  targets(url: string): Promise<SignInTargets>;
  /** Exact-host Credentials read from the local encrypted cache only. */
  localBindings(url: string): Promise<SignInTargets['credentials']>;
  save(url: string, target: SignInWriteTarget, binding: SignInBinding, label: string,
    stillAuthorized: () => Promise<boolean>): Promise<{ action: 'created' | 'updated' }>;
  isCurrentDocument(source: SignInSource): Promise<boolean>;
  notify(tabId: number): void;
  now?: () => number;
  createId?: () => string;
}

interface StoredPrompt {
  readonly view: SignInPrompt;
  readonly accounts: Map<string, { account: string | null; entry: SignInEntryReference | null }>;
  readonly targets: Map<string, SignInWriteTarget>;
  readonly documentId: string;
  readonly browserDocumentId: string;
}

interface Flow {
  readonly serviceTabId: number;
  readonly serviceOrigin: string;
  readonly startedAt: number;
  readonly providerTabIds: Set<number>;
  provider: SignInProvider | null;
  phase: 'started' | 'provider' | 'returned';
  usedAccount: string | null;
  usedEntry: SignInEntryReference | null;
  usedManually: boolean;
  chosen: SignInBinding | null;
  prompt: StoredPrompt | null;
  /** Single in-flight build per document, so concurrent refreshes return the same prompt IDs. */
  building: { readonly documentKey: string; readonly view: Promise<SignInPrompt | null> } | null;
  error: boolean;
}

interface StoredSuggestion {
  readonly tabId: number;
  readonly browserDocumentId: string;
  readonly binding: SignInBinding;
}

export const SIGN_IN_FIELD_LABELS: Readonly<Record<SignInLocale, string>> = {
  en: 'Sign-in method',
  pl: 'Metoda logowania',
};

function httpsOrigin(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.origin : null; } catch { return null; }
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/**
 * Memory-only coordinator. A flow starts on an HTTPS service page and is
 * linked to a provider only by a browser-authored authorization URL in the same
 * tab or in a popup opened by that tab. Returning is not proof of success, so
 * remembering always waits for an explicit choice in the closed surface.
 * Nothing about OAuth codes, tokens, state or cookies is read or stored.
 */
export class FederatedSignInCoordinator {
  private readonly flows = new Map<number, Flow>();
  private readonly lastServiceOrigin = new Map<number, string>();
  /** Tab IDs that already had a registered top-frame document; values only, kept across lock. */
  private readonly knownTabs = new Set<number>();
  private readonly suggestions = new Map<string, StoredSuggestion>();
  private readonly mutedHosts = new Set<string>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly deps: FederatedSignInDeps) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? (() => crypto.randomUUID().replaceAll('-', ''));
  }

  /** Called for every browser-registered top-frame document. */
  documentConnected(tabId: number, url: string, openerTabId: number | undefined): void {
    this.expire();
    const fresh = !this.knownTabs.has(tabId);
    this.knownTabs.add(tabId);
    const page = classifyProviderUrl(url);
    if (page !== null) {
      this.providerDocument(tabId, page, fresh ? openerTabId : undefined);
      return;
    }
    if (isProviderSignInHost(url)) return;
    const origin = httpsOrigin(url);
    const popupFlow = this.flowForProviderTab(tabId);
    if (popupFlow !== null && popupFlow.serviceTabId !== tabId) {
      if (isAuthorizationErrorReturn(url)) {
        this.cancel(popupFlow);
        return;
      }
      if (popupFlow.phase === 'provider' && origin !== null
        && registrableDomain(origin) === registrableDomain(popupFlow.serviceOrigin)) {
        this.returned(popupFlow);
        return;
      }
      // A popup that browses to an unrelated site no longer represents this sign-in.
      popupFlow.providerTabIds.delete(tabId);
    }
    const flow = this.flows.get(tabId);
    if (flow !== undefined && flow.phase === 'provider') {
      if (origin !== null && registrableDomain(origin) === registrableDomain(flow.serviceOrigin)) {
        if (isAuthorizationErrorReturn(url)) this.cancel(flow);
        else this.returned(flow);
      }
    } else if (flow !== undefined && flow.phase === 'returned' && (origin === null
      || registrableDomain(origin) !== registrableDomain(flow.serviceOrigin))) {
      this.flows.delete(tabId);
    }
    if (origin !== null) this.lastServiceOrigin.set(tabId, origin);
    else this.lastServiceOrigin.delete(tabId);
  }

  tabRemoved(tabId: number): void {
    this.lastServiceOrigin.delete(tabId);
    this.knownTabs.delete(tabId);
    for (const [key, suggestion] of this.suggestions) if (suggestion.tabId === tabId) this.suggestions.delete(key);
    this.flows.delete(tabId);
    for (const flow of this.flows.values()) {
      if (!flow.providerTabIds.delete(tabId) || flow.phase !== 'provider' || flow.providerTabIds.size > 0) continue;
      // A closed popup cannot prove success or cancellation; only ask.
      this.returned(flow);
    }
  }

  /** Session lock or account change discards every pending observation. */
  clear(): void {
    this.flows.clear();
    this.suggestions.clear();
    this.mutedHosts.clear();
  }

  /**
   * Account that Palladin itself filled on the provider page during this flow.
   * The username comes from the unlocked MemberIndex, never from page text. An
   * automatic fill is only offered as an option: the user may still switch
   * accounts in the provider's own chooser, which Palladin cannot observe.
   */
  providerFilled(tabId: number, url: string,
    entry: Pick<EntryMetadata, 'username' | 'urlDomain' | 'vaultId' | 'id'> | undefined,
    intent: 'automatic' | 'manual'): void {
    if (!isProviderSignInHost(url)) return;
    const flow = this.flowForProviderTab(tabId) ?? this.flows.get(tabId);
    const account = normalizeSignInAccount(entry?.username ?? null);
    if (flow?.phase !== 'provider' || flow.provider === null || account === null || account.length > 256) return;
    if (!SIGN_IN_PROVIDER_ACCOUNT_DOMAINS[flow.provider].includes(registrableDomain(entry?.urlDomain) ?? '')) return;
    flow.usedAccount = account;
    flow.usedEntry = entry === undefined ? null : { vaultId: entry.vaultId, entryId: entry.id };
    flow.usedManually = intent === 'manual';
  }

  /** Explicitly chosen provider account to rank first on that provider's page. */
  preferredProviderEntry(tabId: number, url: string, candidates: readonly EntryMetadata[]): EntryMetadata | null {
    if (!isProviderSignInHost(url)) return null;
    const flow = this.flowForProviderTab(tabId) ?? this.flows.get(tabId);
    const chosen = flow?.chosen ?? null;
    if (flow?.phase !== 'provider' || chosen === null || chosen.provider !== flow.provider) return null;
    const matches = chosen.entry !== null
      ? candidates.filter((entry) => sameSignInEntry({ vaultId: entry.vaultId, entryId: entry.id }, chosen.entry))
      : chosen.account === null ? []
        : candidates.filter((entry) => sameSignInAccount(entry.username ?? null, chosen.account));
    return matches.length === 1 ? matches[0]! : null;
  }

  async dispatch(command: FederatedSignInCommand, source: SignInSource): Promise<FederatedSignInResult> {
    this.expire();
    const origin = httpsOrigin(source.url);
    if (origin === null) return { status: 'stale' };
    switch (command.type) {
      case 'intent':
        this.start(source.tabId, origin);
        return { status: 'accepted' };
      case 'suggest':
        return this.suggest(source);
      case 'choose':
        return this.choose(command.suggestionId, source, origin);
      case 'get':
        return { status: 'prompt', prompt: await this.prompt(source) };
      case 'confirm':
        return this.confirm(command, source);
      case 'dismiss': {
        const flow = this.flows.get(source.tabId);
        if (flow?.prompt?.view.id === command.promptId) {
          this.mutedHosts.add(hostOf(flow.serviceOrigin));
          this.flows.delete(source.tabId);
        }
        return { status: 'dismissed' };
      }
      case 'unlock':
        return { status: 'accepted' };
    }
  }

  private start(tabId: number, serviceOrigin: string): Flow {
    const existing = this.flows.get(tabId);
    if (existing !== undefined && existing.serviceOrigin === serviceOrigin && existing.phase !== 'returned') return existing;
    if (this.flows.size >= MAX_FLOWS) {
      const oldest = [...this.flows.entries()].sort((left, right) => left[1].startedAt - right[1].startedAt)[0];
      if (oldest) this.flows.delete(oldest[0]);
    }
    const flow: Flow = { serviceTabId: tabId, serviceOrigin, startedAt: this.now(), providerTabIds: new Set(),
      provider: null, phase: 'started', usedAccount: null, usedEntry: null, usedManually: false, chosen: null, prompt: null, building: null, error: false };
    this.flows.set(tabId, flow);
    return flow;
  }

  /**
   * Links a provider document to the service tab (same tab) or to the opener of
   * a popup. Without an explicit intent, only a third-party authorization
   * request may start a flow; the provider's own sign-in pages never do.
   */
  private providerDocument(tabId: number, page: ProviderPage, openerTabId: number | undefined): void {
    let flow = this.flowForProviderTab(tabId) ?? this.activeFlow(tabId);
    if (flow === null && openerTabId !== undefined && openerTabId !== tabId) {
      flow = this.activeFlow(openerTabId);
      const openerOrigin = this.lastServiceOrigin.get(openerTabId);
      if (flow === null && page.authorizationRequest && openerOrigin !== undefined) flow = this.start(openerTabId, openerOrigin);
    }
    if (flow === null) {
      const previous = this.lastServiceOrigin.get(tabId);
      if (previous === undefined || !page.authorizationRequest) return;
      flow = this.start(tabId, previous);
    }
    // Only an authorization request may establish or switch the provider; a
    // generic provider sign-in page can merely continue an established flow.
    if (flow.provider !== page.provider && !page.authorizationRequest) return;
    if (flow.provider !== null && flow.provider !== page.provider) {
      flow.usedAccount = null; flow.usedEntry = null; flow.usedManually = false;
    }
    flow.provider = page.provider;
    flow.phase = 'provider';
    if (tabId !== flow.serviceTabId) flow.providerTabIds.add(tabId);
  }

  private activeFlow(tabId: number): Flow | null {
    const flow = this.flows.get(tabId);
    return flow === undefined || flow.phase === 'returned' ? null : flow;
  }

  /** The return may land on another host of the same registrable domain; writes stay bound to the start host. */
  private sameService(url: string, flow: Flow): boolean {
    const origin = httpsOrigin(url);
    return origin !== null && registrableDomain(origin) === registrableDomain(flow.serviceOrigin);
  }

  private flowForProviderTab(tabId: number): Flow | null {
    for (const flow of this.flows.values()) if (flow.providerTabIds.has(tabId)) return flow;
    return null;
  }

  private returned(flow: Flow): void {
    if (flow.provider === null || this.mutedHosts.has(hostOf(flow.serviceOrigin))) {
      this.flows.delete(flow.serviceTabId);
      return;
    }
    flow.phase = 'returned';
    flow.providerTabIds.clear();
    this.deps.notify(flow.serviceTabId);
  }

  private cancel(flow: Flow): void {
    this.flows.delete(flow.serviceTabId);
  }

  private expire(): void {
    const now = this.now();
    for (const [tabId, flow] of this.flows) if (now - flow.startedAt > FLOW_TTL_MS) this.flows.delete(tabId);
  }

  private async suggest(source: SignInSource): Promise<FederatedSignInResult> {
    const session = await this.deps.getSession();
    if (!session?.unlocked) return { status: 'suggestions', suggestions: [] };
    // Local encrypted cache only: an ordinary page load never asks the server about this site.
    const local = await this.deps.localBindings(source.url);
    for (const [key, suggestion] of this.suggestions) if (suggestion.tabId === source.tabId) this.suggestions.delete(key);
    const suggestions = local.flatMap((credential) => {
      if (credential.signIn.status !== 'recognized') return [];
      const id = this.createId();
      this.suggestions.set(id, { tabId: source.tabId, browserDocumentId: source.browserDocumentId,
        binding: credential.signIn.binding });
      return [{ id, provider: credential.signIn.binding.provider, account: credential.signIn.binding.account,
        label: credential.label, vaultLabel: credential.vaultLabel }];
    }).slice(0, 20);
    if ((await this.deps.getSession())?.generation !== session.generation) return { status: 'suggestions', suggestions: [] };
    return { status: 'suggestions', suggestions };
  }

  private choose(suggestionId: string, source: SignInSource, origin: string): FederatedSignInResult {
    const suggestion = this.suggestions.get(suggestionId);
    if (suggestion === undefined || suggestion.tabId !== source.tabId
      || suggestion.browserDocumentId !== source.browserDocumentId) return { status: 'stale' };
    const flow = this.start(source.tabId, origin);
    flow.chosen = suggestion.binding;
    return { status: 'chosen', provider: suggestion.binding.provider };
  }

  private async prompt(source: SignInSource): Promise<SignInPrompt | null> {
    const flow = this.flows.get(source.tabId);
    if (flow === undefined || flow.phase !== 'returned' || flow.provider === null
      || !this.sameService(source.url, flow)) return null;
    const site = hostOf(flow.serviceOrigin);
    const session = await this.deps.getSession();
    if (!session?.unlocked) {
      return { id: flow.prompt?.view.id ?? this.createId(), site, provider: flow.provider, state: 'locked',
        accounts: [], targets: [], defaultAccountId: null, defaultTargetId: null };
    }
    if (flow.prompt !== null && flow.prompt.browserDocumentId === source.browserDocumentId
      && flow.prompt.documentId === source.documentId) {
      return flow.error ? { ...flow.prompt.view, error: 'save-failed' } : flow.prompt.view;
    }
    const documentKey = `${source.browserDocumentId}:${source.documentId}`;
    if (flow.building?.documentKey === documentKey) return flow.building.view;
    const view = this.buildPrompt(flow, source, session, site);
    flow.building = { documentKey, view };
    try { return await view; } finally { if (flow.building?.view === view) flow.building = null; }
  }

  private async buildPrompt(flow: Flow, source: SignInSource, session: SignInSession, site: string): Promise<SignInPrompt | null> {
    const provider = flow.provider!;
    const [targets, providerAccounts] = await Promise.all([
      this.deps.targets(flow.serviceOrigin), this.deps.providerAccounts(provider)]);
    if ((await this.deps.getSession())?.generation !== session.generation || this.flows.get(source.tabId) !== flow) return null;
    const chosenSame = flow.chosen?.provider === provider;
    // A Palladin fill of a different account than the one chosen is an account switch: never suppress or guess.
    const switched = chosenSame && flow.usedAccount !== null && !sameSignInAccount(flow.usedAccount, flow.chosen!.account);
    const preferred = switched ? (flow.usedManually ? flow.usedAccount : null)
      : chosenSame ? flow.chosen!.account : flow.usedManually ? flow.usedAccount : null;
    const alreadyRemembered = !switched && (chosenSame || preferred !== null)
      && targets.credentials.some((credential) => credential.signIn.status === 'recognized'
        && credential.signIn.binding.provider === provider && sameSignInAccount(credential.signIn.binding.account, preferred));
    if (alreadyRemembered) {
      this.flows.delete(source.tabId);
      return null;
    }
    const accounts = new Map<string, { account: string | null; entry: SignInEntryReference | null }>();
    const accountViews: SignInAccountOption[] = [];
    // An Agent-visible reference is attached only to a discoverable provider Credential the user can pick.
    const discoverable = (entry: SignInEntryReference | null) => entry === null ? null
      : providerAccounts.find((candidate) => sameSignInEntry(candidate.entry, entry))?.entry ?? null;
    // Each choice is one (account, Entry) pair: an account-only choice is never silently
    // upgraded to an Entry reference, and same-account Credentials stay separate.
    const contextOf = (entry: SignInEntryReference | null) => entry === null ? undefined
      : providerAccounts.find((candidate) => sameSignInEntry(candidate.entry, entry))?.context;
    const addAccount = (value: string | null, entry: SignInEntryReference | null, sourceKind: SignInAccountSource) => {
      // Keep one slot for "Account not specified" within the content guard limit.
      if (value !== null && accountViews.length >= MAX_SIGN_IN_PROMPT_ACCOUNTS - 1) return;
      if (value !== null && [...accounts.values()].some((candidate) => sameSignInAccount(candidate.account, value)
        && sameSignInEntry(candidate.entry, entry))) return;
      const id = this.createId();
      accounts.set(id, { account: value, entry });
      const context = contextOf(entry);
      accountViews.push({ id, label: value ?? '', source: sourceKind, ...(context ? { context } : {}) });
    };
    if (flow.chosen?.provider === provider && flow.chosen.account !== null) {
      addAccount(flow.chosen.account, discoverable(flow.chosen.entry), 'chosen');
    }
    if (flow.usedAccount !== null) addAccount(flow.usedAccount, discoverable(flow.usedEntry), 'used');
    for (const credential of targets.credentials) {
      if (credential.signIn.status === 'recognized' && credential.signIn.binding.provider === provider
        && credential.signIn.binding.account !== null) {
        addAccount(credential.signIn.binding.account, discoverable(credential.signIn.binding.entry), 'saved');
      }
    }
    const vaultAccounts = [...providerAccounts]
      .filter((candidate) => candidate.account.length <= 256)
      .sort((left, right) => left.account.localeCompare(right.account));
    for (const candidate of vaultAccounts.slice(0, MAX_VAULT_ACCOUNTS)) addAccount(candidate.account, candidate.entry, 'vault');
    addAccount(null, null, 'none');
    const defaultAccountId = preferred === null ? null
      : [...accounts.entries()].find(([, value]) => sameSignInAccount(value.account, preferred))?.[0] ?? null;

    const targetMap = new Map<string, SignInWriteTarget>();
    const targetViews: SignInTargetOption[] = [];
    // Create targets come first in the budget so a new record is always possible; updates fill the rest.
    const createVaults = targets.vaults.slice(0, MAX_CREATE_TARGETS);
    const updateBudget = MAX_SIGN_IN_PROMPT_TARGETS - createVaults.length;
    for (const credential of (targets.writable ? targets.credentials : []).slice(0, updateBudget)) {
      if (credential.signIn.status === 'unrecognized' || credential.signIn.status === 'ambiguous') continue;
      const id = this.createId();
      targetMap.set(id, { action: 'update', vaultId: credential.vaultId, entryId: credential.entryId, revision: credential.revision });
      targetViews.push({ id, action: 'update', vaultLabel: credential.vaultLabel,
        label: credential.username ? `${credential.label} (${credential.username})` : credential.label,
        current: credential.signIn.status === 'recognized'
          ? { provider: credential.signIn.binding.provider, account: credential.signIn.binding.account } : null });
    }
    let defaultTargetId: string | null = null;
    for (const vault of createVaults) {
      const id = this.createId();
      targetMap.set(id, { action: 'create', vaultId: vault.vaultId });
      targetViews.push({ id, action: 'create', label: site, vaultLabel: vault.label, current: null });
      if (vault.isDefault && targets.credentials.length === 0) defaultTargetId = id;
    }
    const sameProvider = targetViews.filter((target) => target.current?.provider === provider);
    if (sameProvider.length === 1 && preferred !== null && sameSignInAccount(sameProvider[0]!.current!.account, null)) {
      defaultTargetId = sameProvider[0]!.id;
    }
    const view: SignInPrompt = { id: this.createId(), site, provider, state: 'ready', accounts: accountViews,
      targets: targetViews, defaultAccountId, defaultTargetId };
    flow.prompt = { view, accounts, targets: targetMap, documentId: source.documentId,
      browserDocumentId: source.browserDocumentId };
    flow.error = false;
    return view;
  }

  private async confirm(command: Extract<FederatedSignInCommand, { type: 'confirm' }>, source: SignInSource):
    Promise<FederatedSignInResult> {
    const flow = this.flows.get(source.tabId);
    const stored = flow?.prompt;
    if (flow === undefined || stored === undefined || stored === null || stored.view.id !== command.promptId
      || stored.browserDocumentId !== source.browserDocumentId || stored.documentId !== source.documentId
      || !this.sameService(source.url, flow) || flow.provider === null) return { status: 'stale' };
    if (!stored.accounts.has(command.accountId) || !stored.targets.has(command.targetId)) return { status: 'stale' };
    const session = await this.deps.getSession();
    if (!session?.unlocked) return { status: 'prompt', prompt: await this.prompt(source) };
    const chosenAccount = stored.accounts.get(command.accountId)!;
    const binding: SignInBinding = { provider: flow.provider, account: chosenAccount.account, entry: chosenAccount.entry };
    const stillAuthorized = async () => (await this.deps.getSession())?.generation === session.generation
      && this.flows.get(source.tabId) === flow && await this.deps.isCurrentDocument(source);
    try {
      const saved = await this.deps.save(flow.serviceOrigin, stored.targets.get(command.targetId)!, binding,
        SIGN_IN_FIELD_LABELS[command.locale], stillAuthorized);
      if (this.flows.get(source.tabId) === flow) this.flows.delete(source.tabId);
      return { status: 'saved', action: saved.action };
    } catch {
      if (this.flows.get(source.tabId) !== flow) return { status: 'stale' };
      // A conflict or failure invalidates opaque targets; the next view is rebuilt from fresh state.
      flow.prompt = null;
      const view = await this.prompt(source);
      flow.error = view !== null;
      return { status: 'prompt', prompt: view === null ? null : { ...view, error: 'save-failed' } };
    }
  }
}
