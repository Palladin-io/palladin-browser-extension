import { openInlineCaptureReview } from './capture-review-host';
import en from "../../popup/locales/en.json";
import pl from "../../popup/locales/pl.json";
import { captureNoticeIdentity, captureNoticeHeader, CAPTURE_NOTICE_STYLES } from "./capture-notice-chrome";
import type { ThemePreference, UiLocale } from "@shared/config/ui-preferences";
import {
  CREDENTIAL_CAPTURE_CHANNEL,
  isCredentialCaptureResult,
  type CredentialCaptureCommand,
  type CredentialCapturePrompt,
  type CredentialCaptureResult,
} from "@shared/messaging/credential-capture";
import { createClosedSurface } from "./closed-surface";

type CopyKey = Extract<keyof typeof en, `captureToast.${string}` | `captureReview.${string}` | "inline.openFromToolbar" | "secretCapture.dismiss">;
type WithoutDocument<T> = T extends CredentialCaptureCommand ? Omit<T, "channel" | "documentId"> : never;
type ToastAction = WithoutDocument<Extract<CredentialCaptureCommand, { type: "save" | "dismiss" | "mute" | "unlock" | 'choose-username' }>>;

export class CredentialCaptureToast {
  private readonly surface: ReturnType<typeof createClosedSurface>;
  private readonly panel: HTMLDivElement;
  private prompt: CredentialCapturePrompt | null = null;
  private targetId: string | null = null;
  private busy = false;
  private error = false;
  private manualOpen = false;
  private inlineError = false;
  private reviewingId: string | null = null;
  private locale: UiLocale = "en";
  private theme: ThemePreference = "system";
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly doc: Document,
    private readonly documentId: string,
    private readonly send: (command: CredentialCaptureCommand) => Promise<unknown>,
  ) {
    this.surface = createClosedSurface(doc, "palladin-capture");
    for (const [key, value] of Object.entries({ top: "16px", right: "16px",
      width: "min(420px, calc(100vw - 32px))", "pointer-events": "auto" })) {
      this.surface.host.style.setProperty(key, value, "important");
    }
    const style = doc.createElement("style");
    style.textContent = CAPTURE_NOTICE_STYLES;
    this.panel = doc.createElement("div");
    this.panel.className = "panel";
    this.panel.setAttribute("role", "region");
    this.surface.shadow.append(style, this.panel);
  }

  setAppearance(locale: UiLocale, theme: ThemePreference): void {
    this.locale = locale;
    this.theme = theme;
    this.surface.host.dataset.theme = theme === "system"
      ? this.doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light" : theme;
    if (this.prompt && !this.busy) this.render();
  }

  systemThemeChanged(): void { this.setAppearance(this.locale, this.theme); }

  show(result: CredentialCaptureResult): void {
    if (result.status === 'prompt' && result.prompt?.id === this.reviewingId) return;
    if (this.disposed) return;
    if (result.status === "saved") {
      this.prompt = null;
      this.panel.replaceChildren(captureNoticeHeader(this.doc), this.bodyTitle(result.action === "updated" ? "captureToast.updated" : "captureToast.saved"));
      this.panel.setAttribute("role", "status");
      this.mount();
      this.closeTimer = setTimeout(() => this.hide(), 3_000);
    } else if (result.status === "prompt" && result.prompt) {
      if (this.prompt?.id !== result.prompt.id) {
        if (this.closeTimer !== null) clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.hide(), 3 * 60_000);
        this.targetId = result.prompt.defaultTargetId;
        this.error = false;
        this.manualOpen = false;
      } else if (!result.prompt.targets.some((target) => target.id === this.targetId)) {
        this.targetId = result.prompt.defaultTargetId;
      }
      this.error = result.prompt.error === "save-failed";
      this.prompt = result.prompt;
      this.render();
      this.mount();
    } else if (result.status === "dismissed" || result.status === "stale"
      || (result.status === "prompt" && result.prompt === null)) {
      this.hide();
    }
  }

  stop(): void { this.disposed = true; this.hide(); }

  isOwnedSurface(element: Element): boolean { return element === this.surface.host; }

  private mount(): void {
    if (!this.surface.host.isConnected) this.doc.documentElement.append(this.surface.host);
  }

  private hide(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.prompt = null;
    this.surface.host.remove();
    this.panel.replaceChildren();
  }

  private render(): void {
    const prompt = this.prompt;
    if (!prompt) return;
    this.panel.setAttribute("role", "region");
    const target = prompt.targets.find((candidate) => candidate.id === this.targetId);
    const titleKey = target?.action === "update" ? "captureReview.updatePassword" : "captureReview.saveLogin";
    this.panel.setAttribute("aria-label", this.text(titleKey));
    const header = captureNoticeHeader(this.doc);
    const body = this.bodyTitle(titleKey);
    const close = this.button("×", "close", () => this.perform({ type: "dismiss", promptId: prompt.id }));
    close.setAttribute("aria-label", this.text("captureToast.close"));
    header.append(close);
    const site = this.doc.createElement("div");
    site.className = "site";
    site.textContent = this.text('captureReview.source').replace('{origin}',prompt.notice?.site ?? prompt.site);
    body.append(site);
    if (prompt.state === 'ready') body.append(captureNoticeIdentity(this.doc, prompt.notice ?? {kind:'credential',site:prompt.site,name:prompt.site,detail:''}, prompt.notice?.detail ?? ''));
    this.panel.replaceChildren(header, body);
    if (this.inlineError) body.append(this.note('captureReview.openError', true));
    if (this.manualOpen) body.append(this.note("inline.openFromToolbar", true));
    if (this.error) body.append(this.note("captureToast.error", true));

    if (prompt.state === "locked") body.append(this.note('captureToast.locked'));
    const footer = this.doc.createElement("div");
    footer.className = "footer";
    footer.append(
      this.button(this.text("secretCapture.dismiss"), "secondary", () => this.perform({ type: "dismiss", promptId: prompt.id })),
      this.button(this.text(prompt.state === 'locked' ? 'captureToast.unlock' : 'captureReview.review'), 'primary', () => this.perform({ type: 'unlock' })),
    );
    body.append(this.button(this.text("captureToast.mute"), "site-mute", () => this.perform({ type: "mute", promptId: prompt.id })));
    this.panel.append(footer);
  }

  private button(label: string, className: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.disabled = this.busy;
    button.addEventListener("click", (event) => {
      if (!button.disabled && this.surface.acceptsAction(event, button)) void action();
    });
    return button;
  }

  private bodyTitle(key: CopyKey): HTMLDivElement {
    const body = this.doc.createElement("div");
    body.className = "notice-body";
    const title = this.doc.createElement("h2");
    title.className = "notice-title";
    title.textContent = this.text(key);
    body.append(title);
    return body;
  }

  private note(key: CopyKey, error = false): HTMLDivElement {
    const note = this.doc.createElement("div");
    note.className = error ? "note error" : "note";
    note.textContent = this.text(key);
    if (error) note.setAttribute("role", "alert");
    return note;
  }

  private text(key: CopyKey, name = ""): string {
    return (this.locale === "pl" ? pl : en)[key].replace("{name}", name);
  }

  private async perform(action: ToastAction): Promise<void> {
    if (this.busy) return;
    if (action.type === 'unlock' && this.prompt?.state === 'ready') {
      const pendingId = this.prompt.id;
      const rect = this.surface.host.getBoundingClientRect();
      this.busy = true;
      const opened = await openInlineCaptureReview(this.doc, this.documentId, 'login', pendingId, {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        onReady: () => { this.reviewingId = pendingId; this.hide(); },
      }).catch(() => false);
      this.busy = false;
      if (!opened && this.prompt?.id === pendingId) {
        this.inlineError = true;
        this.render();
      }
      return;
    }
    const pendingId = this.prompt?.id;
    this.busy = true;
    this.error = false;
    this.manualOpen = false;
    this.render();
    let result: unknown;
    try { result = await this.send({ ...action, channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: this.documentId }); }
    catch { result = null; }
    this.busy = false;
    if (this.disposed || this.prompt?.id !== pendingId) return;
    if (!isCredentialCaptureResult(result) || result.status === "unavailable") {
      this.manualOpen = action.type === "unlock";
      this.error = !this.manualOpen;
      this.render();
    } else if (result.status === "accepted") this.render();
    else this.show(result);
  }
}
