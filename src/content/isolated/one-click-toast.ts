import type { SignInProvider } from '@shared/signin/providers';
import type { ThemePreference, UiLocale } from '@shared/config/ui-preferences';
import en from '../../popup/locales/en.json';
import pl from '../../popup/locales/pl.json';
import brandLogoUrl from '../../../icons/icon-128.png?inline';
import { captureNoticeCloseIcon, captureNoticeIdentity, CAPTURE_NOTICE_STYLES } from './capture-notice-chrome';
import { createClosedSurface } from './closed-surface';
import toastStyles from './one-click-toast.css?inline';

export type OneClickCopyKey = Extract<keyof typeof en, `oneClick.${string}`>;
export interface OneClickAccount {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly vault: string;
  /** Shown first when the sign-in host differs from the saved one. */
  readonly host?: string;
  readonly icon?: string;
  readonly provider?: SignInProvider;
}
export interface OneClickToastEvents {
  signIn(account: OneClickAccount): void;
  unlock(): void;
  stop(): void;
  dismiss(): void;
  mute(): void;
}

const COUNTDOWN_MS = 12_000;
// A page can make the surface appear under a click already in progress.
const ARMING_DELAY_MS = 500;

export class OneClickToast {
  private readonly surface: ReturnType<typeof createClosedSurface>;
  private readonly panel: HTMLDivElement;
  private locale: UiLocale = 'en';
  private armedAt = 0;
  private accounts: readonly OneClickAccount[] = [];
  private selected: OneClickAccount | null = null;
  private menu: HTMLElement | null = null;
  private menuToggle: HTMLButtonElement | null = null;

  constructor(private readonly doc: Document, private readonly site: string, private readonly events: OneClickToastEvents) {
    this.surface = createClosedSurface(doc, 'palladin-capture');
    for (const [key, value] of Object.entries({ top: '16px', left: 'max(16px, calc(50vw - 210px))',
      width: 'min(420px, calc(100vw - 32px))', 'pointer-events': 'auto' })) this.surface.host.style.setProperty(key, value, 'important');
    const style = doc.createElement('style');
    style.textContent = CAPTURE_NOTICE_STYLES + toastStyles;
    this.panel = doc.createElement('div');
    this.panel.className = 'panel compact';
    this.surface.shadow.append(style, this.panel);
    this.panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !event.isTrusted) return;
      if (this.menu) { this.closeMenu(); this.menuToggle?.focus(); }
      else if (this.panel.querySelector('.close')) this.events.dismiss();
    });
  }

  get visible(): boolean { return this.surface.host.isConnected; }
  isOwnedSurface(element: Element): boolean { return element === this.surface.host; }
  setAppearance(locale: UiLocale, theme: ThemePreference): void {
    this.locale = locale;
    this.surface.host.dataset.theme = theme === 'system'
      ? this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : theme;
  }

  hide(): void {
    this.closeMenu();
    this.surface.host.remove();
    this.panel.replaceChildren();
    this.accounts = []; this.selected = null;
  }

  /** The document listeners live only while the toast does. */
  private mount(): void {
    if (this.visible) return;
    this.armedAt = performance.now() + ARMING_DELAY_MS;
    this.doc.documentElement.append(this.surface.host);
    const closeOutside = (event: Event) => { if (!event.composedPath().includes(this.surface.host)) this.closeMenu(); };
    const pause = () => {
      if (!this.visible) { this.doc.removeEventListener('pointerdown', closeOutside, true); this.doc.removeEventListener('visibilitychange', pause); return; }
      this.panel.toggleAttribute('data-hidden', this.doc.hidden);
    };
    this.doc.addEventListener('pointerdown', closeOutside, true);
    this.doc.addEventListener('visibilitychange', pause);
    pause();
  }

  showReady(accounts: readonly OneClickAccount[]): void {
    this.accounts = accounts;
    this.selected = accounts.find(account => account.id === this.selected?.id) ?? accounts[0]!;
    this.renderReady();
  }

  showLocked(): void {
    this.bar('oneClick.unlock', 'region', true, true,
      this.line({ id: '', name: this.text('oneClick.locked'), username: '', vault: '' }, this.text('oneClick.locked'), this.text('oneClick.lockedDetail')),
      this.action('oneClick.unlock', () => this.events.unlock()));
  }

  showProgress(account: OneClickAccount, key: OneClickCopyKey, name = ''): void {
    const label = this.text(key, name);
    this.bar(key, 'status', false, false, this.line(account, label, account.username),
      this.button(this.text('oneClick.stop'), 'secondary', () => this.events.stop()));
  }

  showHandOff(account: OneClickAccount, key?: OneClickCopyKey, name = ''): void {
    this.bar('oneClick.handOff', 'status', false, true,
      this.line(account, this.text('oneClick.handOff'), key ? this.text(key, name) : account.username));
  }

  private renderReady(): void {
    const selected = this.selected!;
    const account = this.button('', 'account', () => this.toggleMenu());
    account.append(...this.identity(selected, selected.name, selected.host ? `${selected.host} · ${selected.username}` : selected.username));
    const hint = this.doc.createElement('span');
    hint.className = 'account-hint';
    hint.textContent = this.text(this.accounts.length > 1 ? 'oneClick.change' : 'oneClick.options');
    account.append(hint);
    account.setAttribute('aria-expanded', 'false');
    account.setAttribute('aria-label', this.text('oneClick.changeLabel', selected.username));
    this.bar('oneClick.title', 'region', true, true, account, this.action('oneClick.signIn', () => this.events.signIn(selected)));
    this.menuToggle = account;
  }

  private toggleMenu(): void {
    if (this.menu) { this.closeMenu(); return; }
    const menu = this.doc.createElement('div');
    menu.className = 'menu';
    for (const account of this.accounts) {
      const option = this.button('', 'account', () => { this.selected = account; this.renderReady(); });
      option.append(...this.identity(account, account.name, [account.username, account.vault].filter(Boolean).join(' · ')));
      if (account === this.selected) option.setAttribute('aria-current', 'true');
      menu.append(option);
    }
    const mute = this.button(this.text('oneClick.mute'), 'site-mute', () => this.events.mute());
    const host = this.doc.createElement('small');
    host.textContent = this.site;
    mute.append(host);
    menu.append(mute);
    this.panel.append(menu);
    this.menu = menu;
    this.menuToggle?.setAttribute('aria-expanded', 'true');
  }

  private closeMenu(): void {
    const leaving = this.menu;
    this.menu = null;
    if (leaving) {
      leaving.inert = true;
      leaving.classList.add('leaving');
      const finished = (leaving.getAnimations?.() ?? []).map(animation => animation.finished);
      void Promise.allSettled(finished).then(() => leaving.remove());
    }
    this.menuToggle?.setAttribute('aria-expanded', 'false');
  }

  private bar(label: OneClickCopyKey, role: 'region' | 'status', expires: boolean, closable: boolean, ...content: Node[]): void {
    this.closeMenu();
    this.menuToggle = null;
    const row = this.doc.createElement('div');
    row.className = 'bar';
    row.append(...content);
    this.panel.setAttribute('role', role);
    this.panel.setAttribute('aria-label', this.text(label));
    const strip = this.strip(closable);
    if (expires) strip.append(this.countdown());
    this.panel.replaceChildren(strip, row, ...this.panel.querySelectorAll('.menu.leaving'));
    this.mount();
  }

  private strip(closable: boolean): HTMLDivElement {
    const element = this.doc.createElement('div');
    element.className = 'header toast-strip';
    const brand = this.doc.createElement('span');
    brand.className = 'toast-brand';
    const logo = this.doc.createElement('img');
    logo.src = brandLogoUrl; logo.alt = '';
    const wordmark = this.doc.createElement('strong');
    const domain = this.doc.createElement('span');
    domain.textContent = '.io';
    wordmark.append('Palladin', domain);
    brand.append(logo, wordmark);
    element.append(brand);
    if (closable) {
      const close = this.button('', 'close', () => this.events.dismiss());
      close.setAttribute('aria-label', this.text('oneClick.close'));
      close.append(captureNoticeCloseIcon(this.doc));
      element.append(close);
    }
    return element;
  }

  /** Fills under the brand strip from the logo. Its end only hides the toast; it never signs in. */
  private countdown(): HTMLDivElement {
    const line = this.doc.createElement('div');
    line.className = 'countdown-line';
    line.setAttribute('aria-hidden', 'true');
    line.style.animationDuration = `${COUNTDOWN_MS}ms`;
    line.addEventListener('animationend', () => this.events.dismiss());
    return line;
  }

  private line(account: OneClickAccount, title: string, detail: string): HTMLDivElement {
    const element = this.doc.createElement('div');
    element.className = 'account';
    element.append(...this.identity(account, title, detail));
    return element;
  }

  private identity(account: OneClickAccount, title: string, detail: string): Node[] {
    const summary = captureNoticeIdentity(this.doc, { kind: 'credential', site: this.site, name: title, detail,
      ...(account.icon ? { iconDataUrl: account.icon } : {}) }, detail, account.provider);
    const provider = summary.querySelector('.notice-provider');
    if (provider) { provider.classList.remove('notice-provider'); summary.firstElementChild!.replaceWith(provider); }
    return [...summary.children];
  }

  /** Only the label moves, so the click target never shifts under the pointer. */
  private action(key: OneClickCopyKey, action: () => void): HTMLButtonElement {
    const element = this.button('', 'sign-in', action);
    const label = this.doc.createElement('span');
    label.textContent = this.text(key);
    element.append(label);
    return element;
  }

  private button(label: string, className: string, action: () => void): HTMLButtonElement {
    const element = this.doc.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', event => {
      if (performance.now() >= this.armedAt && this.surface.acceptsAction(event, element)) action();
    });
    return element;
  }

  private text(key: OneClickCopyKey, name = ''): string {
    return (this.locale === 'pl' ? pl : en)[key].replace('{name}', name);
  }
}
