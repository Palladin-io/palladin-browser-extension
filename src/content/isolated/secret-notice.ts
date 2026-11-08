import { createCaptureDismiss } from './capture-dismiss';
import { registrableDomain } from '@shared/security/domain';
import { openInlineCaptureReview } from './capture-review-host';
import type { CaptureNoticeIdentity } from '@shared/messaging/capture-notice';
import { captureNoticeIdentity, captureNoticeHeader, CAPTURE_NOTICE_STYLES } from './capture-notice-chrome';
import en from '../../popup/locales/en.json';
import pl from '../../popup/locales/pl.json';
import { DEFAULT_UI_PREFERENCES, UI_PREFERENCES_STORAGE_KEY, parseUiPreferences, resolveUiLocale } from '@shared/config/ui-preferences';
import { createClosedSurface } from './closed-surface';

export class SecretCaptureNotice {
  private readonly surface: ReturnType<typeof createClosedSurface>;
  private preferences = DEFAULT_UI_PREFERENCES;
  private locked = false;
  private identity: CaptureNoticeIdentity | undefined;
  private stopped = false;
  private dismissControl: ReturnType<typeof createCaptureDismiss> | null = null;
  private actionError = false;
  private busy = false;
  private opening = false;
  private reviewError = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private readonly changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && UI_PREFERENCES_STORAGE_KEY in changes) {
      this.preferences = parseUiPreferences(changes[UI_PREFERENCES_STORAGE_KEY]?.newValue); this.render();
    }
  };
  constructor(private readonly doc: Document, private readonly act: (type: 'open' | 'dismiss' | 'mute') => Promise<void>, private readonly kind: 'secret' | 'totp' = 'secret') {
    this.surface = createClosedSurface(doc, 'palladin-capture');
    for (const [key, value] of Object.entries({ top: '16px', right: '16px', width: 'min(420px, calc(100vw - 32px))', 'pointer-events': 'auto' })) this.surface.host.style.setProperty(key, value, 'important');
    if (typeof chrome !== 'undefined') {
      chrome.storage?.onChanged.addListener(this.changed);
      void chrome.storage?.local.get(UI_PREFERENCES_STORAGE_KEY).then(values => {
        if (!this.stopped) { this.preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY]); this.render(); }
      });
    }
  }
  isOwnedSurface(element: Element): boolean { return element === this.surface.host || this.surface.shadow.contains(element); }
  show(locked: boolean, identity?: CaptureNoticeIdentity): void {
    if (this.stopped) return;
    const next = locked ? undefined : identity;
    const sameIdentity = this.identity === next || !!this.identity && !!next
      && (['kind','site','name','detail','cardBrand','iconDataUrl'] as const).every(key => this.identity![key] === next[key]);
    if (this.surface.host.isConnected && this.locked === locked && sameIdentity) return;
    this.locked = locked; this.identity = next; this.render();
    if (!this.surface.host.isConnected) {
      this.doc.documentElement.append(this.surface.host);
      this.expiry = setTimeout(() => this.hide(), 180_000);
    }
  }
  async review(documentId: string, kind: 'secret' | 'totp', captureId: string): Promise<boolean> {
    if (this.opening || this.stopped) return false;
    this.opening = true;
    this.reviewError = false;
    const rect = this.surface.host.getBoundingClientRect();
    const opened = await openInlineCaptureReview(this.doc, documentId, kind, captureId, {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      onReady: () => this.hide(),
    }).catch(() => false);
    this.opening = false;
    if (!opened && !this.stopped) { this.reviewError = true; this.render(); }
    return opened;
  }
  hide(): void { this.dismissControl?.dispose(); this.dismissControl = null; clearTimeout(this.expiry); this.surface.host.remove(); }
  stop(): void { this.stopped = true; this.hide(); if (typeof chrome !== 'undefined') chrome.storage?.onChanged.removeListener(this.changed); }
  private async runAction(type: 'open' | 'dismiss' | 'mute'): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.actionError = false;
    try { await this.act(type); } catch { this.actionError = true; }
    finally { this.busy = false; if (this.surface.host.isConnected) this.render(); }
  }
  private render(): void {
    this.dismissControl?.dispose(); this.dismissControl = null;
    const lang = resolveUiLocale(this.preferences.language, typeof chrome !== 'undefined' ? chrome.i18n?.getUILanguage() ?? 'en' : 'en');
    const copy = lang === 'pl' ? pl : en;
    const dark = this.preferences.theme === 'dark' || this.preferences.theme === 'system' && this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const style = this.doc.createElement('style');
    style.textContent = CAPTURE_NOTICE_STYLES;
    this.surface.host.dataset.theme = dark ? 'dark' : 'light';
    const panel = this.doc.createElement('div'); panel.className = 'panel'; panel.setAttribute('role','status');
    const header = captureNoticeHeader(this.doc);
    const close=this.doc.createElement('button');close.type='button';close.className='close';close.textContent='×';close.setAttribute('aria-label',copy['captureToast.close']);
    close.addEventListener('click',event=>{if(this.surface.acceptsAction(event,close))void this.runAction('dismiss');});
    header.append(close);panel.append(header);
    const footer = this.doc.createElement('div'); footer.className = 'footer notice-footer';
    const text = this.doc.createElement('div'); text.className = 'notice-body'; text.textContent = copy[this.locked ? 'secretCapture.locked' : this.kind === 'totp' ? 'totpCapture.notice' : 'secretCapture.notice'];
    if (!this.locked && this.identity) {
      text.replaceChildren();
      const title=this.doc.createElement('h2');title.className='notice-title';title.textContent=copy[this.identity.kind==='card'?'captureReview.saveCard':this.identity.kind==='totp'?'totpCapture.title':'captureReview.saveKey'];
      const origin=this.doc.createElement('div');origin.className='site';origin.textContent=copy['captureReview.source'].replace('{origin}',this.identity.site);
      const type=copy[this.identity.kind==='card'?'entry.typeCard':this.identity.kind==='totp'?'captureReview.authenticator':'captureReview.capturedKey'];
      const detail=this.identity.kind==='card' ? `${this.identity.detail} · ${type}` : this.identity.kind==='totp' && this.identity.detail ? copy['captureReview.totpIdentity'].replace('{account}',this.identity.detail) : this.identity.detail || type;
      text.append(title,origin,captureNoticeIdentity(this.doc,{...this.identity,name:this.identity.name||type},detail));
    }
    if (this.reviewError) {
      const error = this.doc.createElement('p'); error.setAttribute('role', 'alert');
      error.textContent = copy['captureReview.openError']; text.append(error);
    }
    if (this.actionError) { const error = this.doc.createElement('p'); error.setAttribute('role','alert'); error.textContent = copy['entry.error']; text.append(error); }
    panel.append(text);
    const button = (label: string, style: string, action: () => void | Promise<void>) => {
      const button = this.doc.createElement('button'); button.type = 'button'; button.className = style; button.textContent = label; button.disabled = this.busy;
      button.addEventListener('click', event => { if (!button.disabled && this.surface.acceptsAction(event,button)) void action(); });
      return button;
    };
    if (!this.locked && this.identity) {
      this.dismissControl = createCaptureDismiss(this.doc, { button,
        dismissLabel: copy['secretCapture.dismiss'], muteLabel: copy['captureToast.mute'], optionsLabel: copy['captureToast.dismissOptions'],
        site: registrableDomain(`https://${this.identity.site}`) ?? this.identity.site,
        onDismiss: () => this.runAction('dismiss'), onMute: () => this.runAction('mute'),
      });
      footer.append(this.dismissControl.element);
    } else footer.append(button(copy['secretCapture.dismiss'],'secondary',() => this.runAction('dismiss')));
    footer.append(button(copy['captureReview.review'],'primary',() => this.runAction('open')));
    panel.append(footer);
    this.surface.shadow.replaceChildren(style, panel);
  }
}
