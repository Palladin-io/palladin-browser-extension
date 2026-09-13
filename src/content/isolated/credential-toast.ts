import en from "../../popup/locales/en.json";
import pl from "../../popup/locales/pl.json";
import palladinIconUrl from "../../../icons/icon-32.png?inline";
import type { ThemePreference, UiLocale } from "@shared/config/ui-preferences";
import {
  CREDENTIAL_CAPTURE_CHANNEL,
  isCredentialCaptureResult,
  type CredentialCaptureCommand,
  type CredentialCapturePrompt,
  type CredentialCaptureResult,
} from "@shared/messaging/credential-capture";
import { createClosedSurface } from "./closed-surface";

type CopyKey = Extract<keyof typeof en, `captureToast.${string}`>;
type WithoutDocument<T> = T extends CredentialCaptureCommand ? Omit<T, "channel" | "documentId"> : never;
type ToastAction = WithoutDocument<Extract<CredentialCaptureCommand, { type: "save" | "dismiss" | "mute" | "unlock" }>>;

export class CredentialCaptureToast {
  private readonly surface: ReturnType<typeof createClosedSurface>;
  private readonly panel: HTMLDivElement;
  private prompt: CredentialCapturePrompt | null = null;
  private targetId: string | null = null;
  private autoUpdate = false;
  private choosing = false;
  private busy = false;
  private error = false;
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
      width: "min(360px, calc(100vw - 32px))", "pointer-events": "auto" })) {
      this.surface.host.style.setProperty(key, value, "important");
    }
    const style = doc.createElement("style");
    style.textContent = STYLES;
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
    if (this.disposed) return;
    if (result.status === "saved") {
      this.prompt = null;
      this.panel.replaceChildren(this.header(result.action === "updated" ? "captureToast.updated" : "captureToast.saved"));
      this.panel.setAttribute("role", "status");
      this.mount();
      this.closeTimer = setTimeout(() => this.hide(), 3_000);
    } else if (result.status === "prompt" && result.prompt) {
      if (this.prompt?.id !== result.prompt.id) {
        if (this.closeTimer !== null) clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.hide(), 3 * 60_000);
        this.targetId = result.prompt.defaultTargetId;
        this.autoUpdate = false;
        this.choosing = false;
        this.error = false;
      } else if (!result.prompt.targets.some((target) => target.id === this.targetId)) {
        this.targetId = result.prompt.defaultTargetId;
        this.autoUpdate = false;
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
    this.autoUpdate = false;
    this.surface.host.remove();
    this.panel.replaceChildren();
  }

  private render(): void {
    const prompt = this.prompt;
    if (!prompt) return;
    this.panel.setAttribute("role", "region");
    const target = prompt.targets.find((candidate) => candidate.id === this.targetId);
    const titleKey = target?.action === "update" ? "captureToast.updateTitle" : "captureToast.title";
    this.panel.setAttribute("aria-label", this.text(titleKey));
    const header = this.header(titleKey);
    const close = this.button("×", "close", () => this.perform({ type: "dismiss", promptId: prompt.id }));
    close.setAttribute("aria-label", this.text("captureToast.close"));
    header.append(close);
    const site = this.doc.createElement("div");
    site.className = "site";
    site.textContent = prompt.site;
    this.panel.replaceChildren(header, site);
    if (this.error) this.panel.append(this.note("captureToast.error", true));

    if (prompt.state === "locked") {
      this.panel.append(this.note("captureToast.locked"),
        this.button(this.text("captureToast.unlock"), "primary", () => this.perform({ type: "unlock" })));
    } else {
      if (this.choosing) {
        const choices = this.doc.createElement("div");
        choices.className = "choices";
        choices.setAttribute("role", "group");
        choices.setAttribute("aria-label", this.text("captureToast.targets"));
        for (const candidate of prompt.targets) {
          const label = this.text(candidate.action === "update" ? "captureToast.update" : "captureToast.save", candidate.label);
          const option = this.button(label, "choice", () => {
            this.targetId = candidate.id;
            this.autoUpdate = false;
            this.choosing = false;
            this.render();
            this.panel.querySelector<HTMLButtonElement>(".primary")?.focus();
          });
          option.title = candidate.action === "update" ? `${candidate.label} (${candidate.vaultLabel})` : candidate.label;
          if (candidate.action === "update") {
            const vault = this.doc.createElement("span");
            vault.className = "choice-vault";
            vault.textContent = candidate.vaultLabel;
            option.append(vault);
          }
          option.setAttribute("aria-pressed", String(candidate.id === this.targetId));
          choices.append(option);
        }
        this.panel.append(choices);
      }
      if (target?.action === "update") {
        const checkbox = this.button(this.text("captureToast.autoUpdate"), "checkbox", () => {
          this.autoUpdate = !this.autoUpdate;
          checkbox.setAttribute("aria-checked", String(this.autoUpdate));
        });
        checkbox.setAttribute("role", "checkbox");
        checkbox.setAttribute("aria-label", this.text("captureToast.autoUpdate"));
        checkbox.setAttribute("aria-checked", String(this.autoUpdate));
        this.panel.append(checkbox);
      }
      const actions = this.doc.createElement("div");
      actions.className = "actions";
      if (target) {
        actions.append(this.button(this.text(this.busy ? "captureToast.saving"
          : target.action === "update" ? "captureToast.update" : "captureToast.save", target.label), "primary", () =>
          this.perform({ type: "save", promptId: prompt.id, targetId: target.id,
            autoUpdate: target.action === "update" && this.autoUpdate })));
      } else this.panel.append(this.note("captureToast.noVault"));
      if (prompt.targets.length > 1) {
        const change = this.button(this.text("captureToast.change"), "secondary", () => {
          this.choosing = !this.choosing;
          this.render();
          if (this.choosing) this.panel.querySelector<HTMLButtonElement>(".choice")?.focus();
        });
        change.setAttribute("aria-expanded", String(this.choosing));
        actions.append(change);
      }
      this.panel.append(actions);
    }
    const footer = this.doc.createElement("div");
    footer.className = "footer";
    footer.append(
      this.button(this.text("captureToast.notNow"), "secondary", () => this.perform({ type: "dismiss", promptId: prompt.id })),
      this.button(this.text("captureToast.mute"), "secondary", () => this.perform({ type: "mute", promptId: prompt.id })),
    );
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

  private header(key: CopyKey): HTMLDivElement {
    const header = this.doc.createElement("div");
    header.className = "header";
    const icon = this.doc.createElement("img");
    icon.src = palladinIconUrl;
    icon.alt = "";
    const title = this.doc.createElement("strong");
    title.textContent = this.text(key);
    header.append(icon, title);
    return header;
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
    const pendingId = this.prompt?.id;
    this.busy = true;
    this.error = false;
    this.render();
    let result: unknown;
    try { result = await this.send({ ...action, channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: this.documentId }); }
    catch { result = null; }
    this.busy = false;
    if (this.disposed || this.prompt?.id !== pendingId) return;
    if (!isCredentialCaptureResult(result) || result.status === "unavailable") {
      this.error = true;
      this.render();
    } else if (result.status === "accepted") this.render();
    else this.show(result);
  }
}

const STYLES = `
  :host { color-scheme:light; --cv-primary:#E54645; --cv-primary-hover:#d43e3e;
    --cv-bg:#f3f5f8; --cv-surface:#fff; --cv-t1:#0c0e12; --cv-t2:#3d4e66;
    --cv-border:rgba(12,14,18,.1); --cv-subtle:rgba(12,14,18,.05); }
  :host([data-theme="dark"]) { color-scheme:dark; --cv-bg:#16161a; --cv-surface:#1f232b;
    --cv-t1:#e8eaed; --cv-t2:#b8c5d4; --cv-border:rgba(232,234,237,.1); --cv-subtle:rgba(232,234,237,.07); }
  * { box-sizing:border-box; }
  .panel { padding:14px; border:1px solid var(--cv-border); border-radius:15px; background:var(--cv-bg);
    color:var(--cv-t1); box-shadow:0 12px 32px rgba(0,0,0,.16); font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; }
  .header { display:flex; gap:9px; align-items:center; }
  .header img { width:22px; height:22px; }
  .header strong { flex:1; font-size:14px; font-weight:700; }
  .site { margin:5px 0 12px 31px; color:var(--cv-t2); font-size:12px; overflow-wrap:anywhere; }
  button { font:inherit; text-transform:none; letter-spacing:normal; cursor:pointer; border:0; border-radius:8px; }
  button:focus-visible { outline:2px solid var(--cv-primary); outline-offset:2px; }
  button:disabled { opacity:.6; cursor:wait; }
  .close { background:transparent; color:var(--cv-t2); font-size:20px; width:28px; height:28px; }
  .actions { display:flex; align-items:stretch; gap:8px; margin-top:12px; }
  .primary { flex:1; min-height:36px; padding:8px 12px; background:var(--cv-primary); color:#fff; font-weight:650; overflow-wrap:anywhere; }
  .primary:hover { background:var(--cv-primary-hover); }
  .secondary { min-height:32px; padding:6px 8px; background:transparent; color:var(--cv-t2); font-size:12px; }
  .secondary:hover,.close:hover { background:var(--cv-subtle); }
  .footer { display:flex; justify-content:space-between; gap:8px; margin:8px -6px -6px; }
  .checkbox { display:flex; align-items:flex-start; gap:8px; padding:4px 0; background:transparent; color:var(--cv-t2); text-align:left; font-size:12px; }
  .checkbox::before { content:""; width:16px; height:16px; flex-shrink:0; border:1px solid var(--cv-border); border-radius:4px; background:var(--cv-surface); }
  .checkbox[aria-checked="true"]::before { content:"✓"; text-align:center; color:#fff; background:var(--cv-primary); border-color:var(--cv-primary); line-height:14px; }
  .choices { display:flex; flex-direction:column; gap:6px; max-height:220px; overflow:auto; margin-bottom:10px; }
  .choice { padding:9px 10px; min-height:36px; text-align:left; background:var(--cv-surface); color:var(--cv-t1); border:1px solid var(--cv-border); overflow-wrap:anywhere; }
  .choice[aria-pressed="true"] { border-color:var(--cv-primary); }
  .choice-vault { display:block; margin-top:3px; color:var(--cv-t2); font-size:12px; }
  .note { font-size:12px; color:var(--cv-t2); margin:8px 0; }
  .error { color:var(--cv-primary); }
`;
