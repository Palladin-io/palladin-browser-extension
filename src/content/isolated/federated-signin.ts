import en from '../../popup/locales/en.json';
import pl from '../../popup/locales/pl.json';
import palladinIconUrl from '../../../icons/icon-32.png?inline';
import {
  DEFAULT_UI_PREFERENCES, UI_PREFERENCES_STORAGE_KEY, parseUiPreferences, resolveUiLocale,
  type ThemePreference, type UiLocale,
} from '@shared/config/ui-preferences';
import {
  FEDERATED_SIGNIN_CHANNEL,
  isFederatedSignInResult,
  type FederatedSignInCommand,
  type FederatedSignInResult,
  type SignInAccountOption,
  type SignInPrompt,
  type SignInSuggestion,
} from '@shared/messaging/federated-signin';
import { SIGN_IN_PROVIDER_NAMES, type SignInProvider } from '@shared/signin/providers';
import { createAgentInjectDomAccess } from './agent-inject';
import { createClosedSurface } from './closed-surface';
import { CLOSED_TOAST_STYLES } from './credential-toast';
import { detectProviderControls, providerForControl, uniqueProviderControl } from './federated-signin-detect';

type CopyKey = Extract<keyof typeof en, `signInToast.${string}`>;
type Body<T> = T extends FederatedSignInCommand ? Omit<T, 'channel' | 'documentId'> : never;
type Send = (command: FederatedSignInCommand) => Promise<unknown>;

// Bounded retries let login controls that render late (SPA, modal) still receive suggestions.
const SUGGEST_DELAYS_MS = [800, 2_500, 6_000] as const;
const PROMPT_DELAY_MS = 600;
// A page can make the surface appear without user input; ignore clicks until it has been visible briefly.
const ARMING_DELAY_MS = 500;

/**
 * Closed-shadow surface for federated sign-in suggestions and confirmation. It
 * has no text inputs; every action requires a trusted click on the surface and
 * the worker rechecks sender, document, origin and session before any write.
 */
export class FederatedSignInSurface {
  private readonly surface: ReturnType<typeof createClosedSurface>;
  private readonly panel: HTMLDivElement;
  private mode: 'none' | 'suggestions' | 'prompt' | 'note' = 'none';
  private suggestions: readonly SignInSuggestion[] = [];
  private prompt: SignInPrompt | null = null;
  private accountId: string | null = null;
  private targetId: string | null = null;
  private choosingTarget = false;
  private busy = false;
  private locale: UiLocale = 'en';
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private armedAt = 0;

  constructor(
    private readonly doc: Document,
    private readonly documentId: string,
    private readonly send: Send,
    private readonly onChoose: (suggestion: SignInSuggestion) => 'opened' | 'manual',
  ) {
    this.surface = createClosedSurface(doc, 'palladin-capture');
    for (const [key, value] of Object.entries({ top: '16px', right: '16px',
      width: 'min(360px, calc(100vw - 32px))', 'pointer-events': 'auto' })) {
      this.surface.host.style.setProperty(key, value, 'important');
    }
    const style = doc.createElement('style');
    style.textContent = CLOSED_TOAST_STYLES + EXTRA_STYLES;
    this.panel = doc.createElement('div');
    this.panel.className = 'panel';
    this.surface.shadow.append(style, this.panel);
  }

  setAppearance(locale: UiLocale, theme: ThemePreference): void {
    this.locale = locale;
    this.surface.host.dataset.theme = theme === 'system'
      ? this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : theme;
    if (!this.busy) this.render();
  }

  isOwnedSurface(element: Element): boolean { return element === this.surface.host; }

  stop(): void { this.disposed = true; this.hide(); }

  /** Lock or sign-out: remembered accounts must not stay visible or clickable. */
  clearSuggestions(): void {
    if (this.mode === 'suggestions' || this.mode === 'note') this.hide();
  }

  showSuggestions(suggestions: readonly SignInSuggestion[]): void {
    if (this.disposed || this.mode === 'prompt' || suggestions.length === 0) return;
    if (this.mode === 'note') this.hide();
    this.suggestions = suggestions;
    this.mode = 'suggestions';
    this.armedAt = Date.now() + ARMING_DELAY_MS;
    this.render();
    this.mount();
  }

  showResult(result: FederatedSignInResult): void {
    if (this.disposed) return;
    if (result.status === 'saved') {
      this.note('signInToast.saved', 3_000);
    } else if (result.status === 'prompt' && result.prompt !== null) {
      if (this.prompt?.id !== result.prompt.id) {
        this.accountId = result.prompt.defaultAccountId;
        this.targetId = result.prompt.defaultTargetId;
        this.choosingTarget = result.prompt.defaultTargetId === null;
        if (this.closeTimer !== null) clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.hide(), 3 * 60_000);
      }
      if (this.prompt?.id !== result.prompt.id) this.armedAt = Date.now() + ARMING_DELAY_MS;
      this.prompt = result.prompt;
      this.mode = 'prompt';
      this.render();
      this.mount();
    } else if (result.status === 'dismissed' || result.status === 'stale'
      || (result.status === 'prompt' && this.mode === 'prompt')) {
      this.hide();
    }
  }

  private note(key: CopyKey, closeAfter: number, name = ''): void {
    this.mode = 'note';
    this.prompt = null;
    this.panel.setAttribute('role', 'status');
    this.panel.replaceChildren(this.header(key, name));
    this.mount();
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.hide(), closeAfter);
  }

  private mount(): void {
    if (this.surface.host.isConnected) return;
    this.armedAt = Date.now() + ARMING_DELAY_MS;
    this.doc.documentElement.append(this.surface.host);
  }

  private hide(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.mode = 'none';
    this.prompt = null;
    this.suggestions = [];
    this.surface.host.remove();
    this.panel.replaceChildren();
  }

  private render(): void {
    if (this.mode === 'suggestions') this.renderSuggestions();
    else if (this.mode === 'prompt') this.renderPrompt();
  }

  private renderSuggestions(): void {
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', this.text('signInToast.suggestTitle'));
    const header = this.header('signInToast.suggestTitle');
    header.append(this.close(() => this.hide()));
    const list = this.doc.createElement('div');
    list.className = 'choices';
    for (const suggestion of this.suggestions) {
      const option = this.button(`${this.providerName(suggestion.provider)} · ${suggestion.account ?? this.text('signInToast.accountUnknown')}`,
        'choice', () => this.choose(suggestion));
      const context = this.doc.createElement('span');
      context.className = 'choice-vault';
      context.textContent = `${suggestion.label} · ${suggestion.vaultLabel}`;
      option.append(context);
      list.append(option);
    }
    this.panel.replaceChildren(header, this.paragraph('signInToast.suggestHint'), list);
  }

  private async choose(suggestion: SignInSuggestion): Promise<void> {
    // Click the page's own provider control synchronously within this trusted
    // action so popup-based sign-in keeps its user activation.
    const outcome = this.onChoose(suggestion);
    const name = this.providerName(suggestion.provider);
    this.note(outcome === 'opened' ? 'signInToast.opening' : 'signInToast.useButton', 5_000, name);
    try {
      await this.send({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: this.documentId, type: 'choose', suggestionId: suggestion.id });
    } catch { /* Ranking help is optional; the user still completes sign-in. */ }
  }

  private renderPrompt(): void {
    const prompt = this.prompt;
    if (!prompt) return;
    const providerName = this.providerName(prompt.provider);
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', this.text('signInToast.title', providerName));
    const header = this.header('signInToast.title', providerName);
    header.append(this.close(() => this.perform({ type: 'dismiss', promptId: prompt.id })));
    const site = this.doc.createElement('div');
    site.className = 'site';
    site.textContent = `${prompt.site} · ${providerName}`;
    this.panel.replaceChildren(header, site);
    if (prompt.error === 'save-failed') this.panel.append(this.paragraph('signInToast.error', true));
    if (prompt.state === 'locked') {
      this.panel.append(this.paragraph('signInToast.locked'),
        this.button(this.text('signInToast.unlock'), 'primary', () => this.perform({ type: 'unlock' })));
      this.panel.append(this.footer(prompt.id));
      return;
    }
    this.panel.append(this.paragraph('signInToast.whichAccount', false, providerName));
    const accounts = this.doc.createElement('div');
    accounts.className = 'choices';
    accounts.setAttribute('role', 'radiogroup');
    accounts.setAttribute('aria-label', this.text('signInToast.whichAccount', providerName));
    for (const account of prompt.accounts) {
      const option = this.button(account.source === 'none' ? this.text('signInToast.accountUnknown') : account.label, 'choice', () => {
        this.accountId = account.id;
        this.render();
      });
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(account.id === this.accountId));
      const hint = [account.context, this.sourceHint(account)].filter((part): part is string => !!part).join(' \u00b7 ') || null;
      if (hint !== null) {
        const small = this.doc.createElement('span');
        small.className = 'choice-vault';
        small.textContent = hint;
        option.append(small);
      }
      accounts.append(option);
    }
    this.panel.append(accounts);

    const target = prompt.targets.find((candidate) => candidate.id === this.targetId);
    if (this.choosingTarget || !target) {
      this.panel.append(this.paragraph('signInToast.whereToSave'));
      const targets = this.doc.createElement('div');
      targets.className = 'choices';
      targets.setAttribute('role', 'radiogroup');
      targets.setAttribute('aria-label', this.text('signInToast.whereToSave'));
      for (const candidate of prompt.targets) {
        const label = candidate.action === 'create' ? this.text('signInToast.newRecord', candidate.label) : candidate.label;
        const option = this.button(label, 'choice', () => {
          this.targetId = candidate.id;
          this.choosingTarget = false;
          this.render();
        });
        option.setAttribute('role', 'radio');
        option.setAttribute('aria-checked', String(candidate.id === this.targetId));
        const context = this.doc.createElement('span');
        context.className = 'choice-vault';
        context.textContent = candidate.current
          ? `${candidate.vaultLabel} · ${this.providerName(candidate.current.provider)} · ${candidate.current.account ?? this.text('signInToast.accountUnknown')}`
          : candidate.vaultLabel;
        option.append(context);
        targets.append(option);
      }
      if (prompt.targets.length === 0) this.panel.append(this.paragraph('signInToast.noVault'));
      this.panel.append(targets);
    }
    const actions = this.doc.createElement('div');
    actions.className = 'actions';
    if (target && this.accountId !== null && prompt.accounts.some((account) => account.id === this.accountId)) {
      actions.append(this.button(this.text(this.busy ? 'signInToast.saving' : 'signInToast.remember',
        target.action === 'create' ? this.text('signInToast.newRecord', target.label) : target.label), 'primary',
      () => this.perform({ type: 'confirm', promptId: prompt.id, accountId: this.accountId!, targetId: target.id,
        locale: this.locale === 'pl' ? 'pl' : 'en' })));
    } else {
      actions.append(this.paragraph('signInToast.chooseFirst'));
    }
    if (target && prompt.targets.length > 1 && !this.choosingTarget) {
      const change = this.button(this.text('signInToast.change'), 'secondary', () => { this.choosingTarget = true; this.render(); });
      change.setAttribute('aria-expanded', 'false');
      actions.append(change);
    }
    this.panel.append(actions, this.footer(prompt.id));
  }

  private footer(promptId: string): HTMLDivElement {
    const footer = this.doc.createElement('div');
    footer.className = 'footer';
    footer.append(this.button(this.text('signInToast.notNow'), 'secondary', () => this.perform({ type: 'dismiss', promptId })));
    return footer;
  }

  private sourceHint(account: SignInAccountOption): string | null {
    switch (account.source) {
      case 'chosen': return this.text('signInToast.sourceChosen');
      case 'used': return this.text('signInToast.sourceUsed');
      case 'saved': return this.text('signInToast.sourceSaved');
      case 'vault': return this.text('signInToast.sourceVault');
      case 'none': return null;
    }
  }

  private async perform(action: Body<FederatedSignInCommand>): Promise<void> {
    if (this.busy) return;
    const pendingId = this.prompt?.id;
    this.busy = true;
    this.render();
    let result: unknown;
    try { result = await this.send({ ...action, channel: FEDERATED_SIGNIN_CHANNEL, documentId: this.documentId } as FederatedSignInCommand); }
    catch { result = null; }
    this.busy = false;
    if (this.disposed || this.prompt?.id !== pendingId) return;
    if (!isFederatedSignInResult(result) || result.status === 'unavailable') {
      if (this.prompt) this.prompt = { ...this.prompt, error: 'save-failed' };
      this.render();
    } else if (result.status === 'accepted') this.render();
    else this.showResult(result);
  }

  private providerName(provider: SignInProvider): string { return SIGN_IN_PROVIDER_NAMES[provider]; }

  private close(action: () => void | Promise<void>): HTMLButtonElement {
    const close = this.button('×', 'close', action);
    close.setAttribute('aria-label', this.text('signInToast.close'));
    return close;
  }

  private button(label: string, className: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.disabled = this.busy;
    button.addEventListener('click', (event) => {
      if (!button.disabled && Date.now() >= this.armedAt && this.surface.acceptsAction(event, button)) void action();
    });
    return button;
  }

  private header(key: CopyKey, name = ''): HTMLDivElement {
    const header = this.doc.createElement('div');
    header.className = 'header';
    const icon = this.doc.createElement('img');
    icon.src = palladinIconUrl;
    icon.alt = '';
    const title = this.doc.createElement('strong');
    title.textContent = this.text(key, name);
    header.append(icon, title);
    return header;
  }

  private paragraph(key: CopyKey, error = false, name = ''): HTMLDivElement {
    const note = this.doc.createElement('div');
    note.className = error ? 'note error' : 'note';
    note.textContent = this.text(key, name);
    if (error) note.setAttribute('role', 'alert');
    return note;
  }

  private text(key: CopyKey, name = ''): string {
    return (this.locale === 'pl' ? pl : en)[key].replace('{name}', name);
  }
}

const EXTRA_STYLES = `
  .choice[aria-checked="true"] { border-color:var(--cv-primary); box-shadow:inset 0 0 0 1px var(--cv-primary); }
`;

/**
 * Top-frame HTTPS controller. Detection is a presentation hint; the worker
 * decides everything security-relevant from browser-authored sender data.
 */
export function startFederatedSignIn(doc: Document, documentId: string, isOtherOwnedSurface: (element: Element) => boolean) {
  let stopped = false;
  let preferences = DEFAULT_UI_PREFERENCES;
  let suggested = false;
  const send: Send = async (command) => chrome.runtime.sendMessage(command);
  const dom = createAgentInjectDomAccess(doc, (element) => surface.isOwnedSurface(element) || isOtherOwnedSurface(element));
  const owned = (element: Element) => surface.isOwnedSurface(element) || isOtherOwnedSurface(element);
  const controls = () => detectProviderControls(doc, (element) => dom.isVisible(element), owned);
  const surface = new FederatedSignInSurface(doc, documentId, send, (suggestion) => {
    const control = uniqueProviderControl(controls(), suggestion.provider);
    if (control === null) return 'manual';
    control.click();
    return 'opened';
  });
  const dispatch = async (command: Body<FederatedSignInCommand>) => {
    try {
      const result = await send({ ...command, channel: FEDERATED_SIGNIN_CHANNEL, documentId } as FederatedSignInCommand);
      return !stopped && isFederatedSignInResult(result) ? result : null;
    } catch { return null; }
  };
  const refreshPrompt = async () => {
    const result = await dispatch({ type: 'get' });
    if (result !== null) surface.showResult(result);
  };
  const suggest = async () => {
    if (suggested || stopped || controls().length === 0) return;
    suggested = true;
    const result = await dispatch({ type: 'suggest' });
    if (result?.status === 'suggestions') surface.showSuggestions(result.suggestions);
    else suggested = false;
  };
  const clicked = (event: MouseEvent) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest('button, a[href], [role="button"], input[type="button"], input[type="submit"]');
    if (control === null || owned(control)) return;
    const provider = providerForControl(control);
    if (provider !== null) void dispatch({ type: 'intent', provider });
  };
  doc.addEventListener('click', clicked, true);
  const promptTimer = setTimeout(() => void refreshPrompt(), PROMPT_DELAY_MS);
  const suggestTimers = SUGGEST_DELAYS_MS.map((delay) => setTimeout(() => void suggest(), delay));
  const applyPreferences = () => surface.setAppearance(
    resolveUiLocale(preferences.language, chrome.i18n.getUILanguage()), preferences.theme);
  const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(UI_PREFERENCES_STORAGE_KEY in changes)) return;
    preferences = parseUiPreferences(changes[UI_PREFERENCES_STORAGE_KEY]?.newValue);
    applyPreferences();
  };
  chrome.storage.onChanged.addListener(storageChanged);
  void chrome.storage.local.get(UI_PREFERENCES_STORAGE_KEY).then((values) => {
    if (stopped) return;
    preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY]);
    applyPreferences();
  }).catch(() => undefined);
  return {
    isOwnedSurface: (element: Element) => surface.isOwnedSurface(element),
    refreshPrompt: () => void refreshPrompt(),
    sessionChanged(unlocked: boolean) {
      if (!unlocked) {
        surface.clearSuggestions();
        suggested = false;
      }
      void refreshPrompt();
      if (unlocked) void suggest();
    },
    stop() {
      stopped = true;
      clearTimeout(promptTimer);
      suggestTimers.forEach(clearTimeout);
      doc.removeEventListener('click', clicked, true);
      chrome.storage.onChanged.removeListener(storageChanged);
      surface.stop();
    },
  };
}
