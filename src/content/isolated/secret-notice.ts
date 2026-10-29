import en from '../../popup/locales/en.json';
import pl from '../../popup/locales/pl.json';
import { DEFAULT_UI_PREFERENCES, UI_PREFERENCES_STORAGE_KEY, parseUiPreferences, resolveUiLocale } from '@shared/config/ui-preferences';
import { createClosedSurface } from './closed-surface';

export class SecretCaptureNotice {
  private readonly surface: ReturnType<typeof createClosedSurface>;
  private preferences = DEFAULT_UI_PREFERENCES;
  private locked = false;
  private stopped = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private readonly changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && UI_PREFERENCES_STORAGE_KEY in changes) {
      this.preferences = parseUiPreferences(changes[UI_PREFERENCES_STORAGE_KEY]?.newValue); this.render();
    }
  };
  constructor(private readonly doc: Document, private readonly act: (type: 'open' | 'dismiss') => Promise<void>) {
    this.surface = createClosedSurface(doc, 'palladin-capture');
    for (const [key, value] of Object.entries({ top: '16px', right: '16px', width: 'min(340px, calc(100vw - 32px))', 'pointer-events': 'auto' })) this.surface.host.style.setProperty(key, value, 'important');
    if (typeof chrome !== 'undefined') {
      chrome.storage?.onChanged.addListener(this.changed);
      void chrome.storage?.local.get(UI_PREFERENCES_STORAGE_KEY).then(values => {
        if (!this.stopped) { this.preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY]); this.render(); }
      });
    }
  }
  isOwnedSurface(element: Element): boolean { return element === this.surface.host || this.surface.shadow.contains(element); }
  show(locked: boolean): void {
    if (this.stopped) return;
    this.locked = locked; this.render();
    if (!this.surface.host.isConnected) {
      this.doc.documentElement.append(this.surface.host);
      this.expiry = setTimeout(() => this.hide(), 180_000);
    }
  }
  hide(): void { clearTimeout(this.expiry); this.surface.host.remove(); }
  stop(): void { this.stopped = true; this.hide(); if (typeof chrome !== 'undefined') chrome.storage?.onChanged.removeListener(this.changed); }
  private render(): void {
    const lang = resolveUiLocale(this.preferences.language, typeof chrome !== 'undefined' ? chrome.i18n?.getUILanguage() ?? 'en' : 'en');
    const copy = lang === 'pl' ? pl : en;
    const dark = this.preferences.theme === 'dark' || this.preferences.theme === 'system' && this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const style = this.doc.createElement('style');
    style.textContent = `:host{--cv-bg:#fff;--cv-t1:#0c0e12;--cv-border:rgba(12,14,18,.1);--cv-primary:#E54645} :host([data-dark]){--cv-bg:#1f232b;--cv-t1:#e8eaed;--cv-border:rgba(232,234,237,.1)} .panel{padding:14px;border:1px solid var(--cv-border);border-radius:12px;background:var(--cv-bg);color:var(--cv-t1);box-shadow:0 12px 32px rgba(0,0,0,.16);font:14px/1.4 system-ui} p{margin:0 0 12px} button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:8px 12px;background:var(--cv-primary);color:#fff} button+button{margin-left:8px;background:transparent;color:var(--cv-t1)} button:focus-visible{outline:2px solid var(--cv-primary);outline-offset:2px}`;
    this.surface.host.toggleAttribute('data-dark', !!dark);
    const panel = this.doc.createElement('div'); panel.className = 'panel'; panel.setAttribute('role','status');
    const text = this.doc.createElement('p'); text.textContent = copy[this.locked ? 'secretCapture.locked' : 'secretCapture.notice']; panel.append(text);
    for (const type of ['open','dismiss'] as const) {
      const button = this.doc.createElement('button'); button.type = 'button'; button.textContent = copy[type === 'open' ? 'secretCapture.review' : 'secretCapture.dismiss'];
      button.addEventListener('click', event => { if (this.surface.acceptsAction(event, button)) void this.act(type).catch(() => undefined); }); panel.append(button);
    }
    this.surface.shadow.replaceChildren(style, panel);
  }
}
