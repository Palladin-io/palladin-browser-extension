import en from "../../popup/locales/en.json";
import pl from "../../popup/locales/pl.json";
import palladinIconUrl from "../../../icons/icon-32.png?inline";
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_STORAGE_KEY,
  parseUiPreferences,
  resolveUiLocale,
  type ThemePreference,
  type UiLocale,
} from "@shared/config/ui-preferences";
import {
  INLINE_AUTOFILL_CHANNEL,
  isInlineAutofillResult,
  type InlineAutofillCommand,
  type InlineAutofillSuggestion,
} from "@shared/messaging";
import {
  isCurrentLoginTarget,
  loginTargetFor,
  submitLoginForm,
  type LoginTarget,
} from "./fill";

type Send = (command: InlineAutofillCommand) => Promise<unknown>;
type InlineKey =
  | "inline.open"
  | "inline.title"
  | "inline.loading"
  | "inline.empty"
  | "inline.locked"
  | "inline.signedOut"
  | "inline.openPalladin"
  | "inline.unlockPalladin"
  | "inline.signInPalladin"
  | "inline.unavailable"
  | "inline.filling"
  | "inline.filled"
  | "inline.fillAndLogin"
  | "inline.logIn"
  | "inline.noForm"
  | "inline.blocked"
  | "inline.vault"
  | "inline.related";

export function startInlineAutofill(
  doc: Document,
  documentId: string,
  send: Send = (command) => chrome.runtime.sendMessage(command),
): {
  invalidateSuggestions(): void;
  isOwnedSurface(element: Element): boolean;
  retryAutomaticFill(): void;
  resolveLoginTarget(loginTargetId: string): LoginTarget | null;
  stop(): void;
} {
  const controller = new InlineAutofillController(doc, documentId, send);
  controller.start();
  return {
    invalidateSuggestions: () => controller.invalidateSuggestions(),
    isOwnedSurface: (element: Element) => controller.isOwnedSurface(element),
    retryAutomaticFill: () => controller.retryAutomaticFill(),
    resolveLoginTarget: (loginTargetId: string) => controller.resolveLoginTarget(loginTargetId),
    stop: () => controller.stop(),
  };
}

export function isLoginField(input: HTMLInputElement): boolean {
  return loginTargetFor(input) !== null;
}

function mutationAffectsLoginDiscovery(record: MutationRecord): boolean {
  if (record.type === "childList") return true;
  if (!(record.target instanceof Element)) return false;
  const target = record.target;
  if (record.attributeName === "form") return target instanceof HTMLInputElement;
  if (record.attributeName === "id") return target instanceof HTMLFormElement;
  if (["class", "style", "hidden", "aria-hidden", "inert", "disabled", "open"]
    .includes(record.attributeName ?? "")) {
    return target instanceof HTMLInputElement || target.querySelector("input") !== null;
  }
  return target instanceof HTMLInputElement;
}

class InlineAutofillController {
  private readonly widgets = new Map<HTMLInputElement, InlineWidget>();
  private observer: MutationObserver | null = null;
  private scheduled = false;
  private locale: UiLocale = "en";
  private theme: ThemePreference = "system";
  private stopped = false;
  private automaticFillUrl: string | null = null;
  private nextLoginTargetId = 1;

  constructor(
    private readonly doc: Document,
    private readonly documentId: string,
    private readonly send: Send,
  ) {}

  start(): void {
    this.scan();
    const view = this.doc.defaultView;
    if (!view) return;
    this.observer = new view.MutationObserver((records) => {
      if (records.some(mutationAffectsLoginDiscovery)) this.scheduleScan();
    });
    this.observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "type",
        "autocomplete",
        "disabled",
        "readonly",
        "hidden",
        "aria-hidden",
        "style",
        "class",
        "inert",
        "form",
        "id",
        "open",
      ],
    });
    view.addEventListener("scroll", this.reposition, true);
    view.addEventListener("resize", this.handleResize);
    this.doc.addEventListener("pointerdown", this.closeOutside, true);
    void this.loadPreferences();
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    const view = this.doc.defaultView;
    view?.removeEventListener("scroll", this.reposition, true);
    view?.removeEventListener("resize", this.handleResize);
    this.doc.removeEventListener("pointerdown", this.closeOutside, true);
    for (const widget of this.widgets.values()) widget.destroy();
    this.widgets.clear();
  }

  retryAutomaticFill(): void {
    if (this.stopped) return;
    const first = this.widgets.values().next().value as InlineWidget | undefined;
    if (first !== undefined) void first.autoFillPreferredExact();
  }

  invalidateSuggestions(): void {
    for (const widget of this.widgets.values()) widget.invalidateSuggestions();
  }

  isOwnedSurface(element: Element): boolean {
    for (const widget of this.widgets.values()) {
      if (widget.host === element) return true;
    }
    return false;
  }

  resolveLoginTarget(loginTargetId: string): LoginTarget | null {
    for (const widget of this.widgets.values()) {
      if (widget.loginTargetId === loginTargetId) return widget.loginTarget;
    }
    return null;
  }

  private readonly reposition = (): void => {
    for (const widget of this.widgets.values()) widget.reposition();
  };

  private readonly handleResize = (): void => {
    this.scheduleScan();
    this.reposition();
  };

  private readonly closeOutside = (event: Event): void => {
    for (const widget of this.widgets.values()) {
      if (!event.composedPath().includes(widget.host)) widget.close();
    }
  };

  private scheduleScan(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopped) this.scan();
    });
  }

  private scan(): void {
    for (const [input, widget] of this.widgets) {
      const currentTarget = input.isConnected ? loginTargetFor(input) : null;
      if (currentTarget === null || !widget.matchesLoginTarget(currentTarget)) {
        widget.destroy();
        this.widgets.delete(input);
      }
    }
    if (this.widgets.size === 0) this.automaticFillUrl = null;
    for (const input of this.doc.querySelectorAll<HTMLInputElement>("input")) {
      const loginTarget = loginTargetFor(input);
      if (loginTarget === null || this.widgets.has(input)) continue;
      const widget = new InlineWidget({
        doc: this.doc,
        input,
        loginTarget,
        loginTargetId: `login-${this.nextLoginTargetId++}`,
        documentId: this.documentId,
        send: this.send,
        locale: () => this.locale,
        theme: () => resolvedTheme(this.theme, this.doc.defaultView),
        closeOthers: () => {
          for (const other of this.widgets.values()) if (other !== widget) other.close();
        },
      });
      this.widgets.set(input, widget);
      widget.mount();
    }
    const currentUrl = this.doc.location.href;
    const first = this.widgets.values().next().value as InlineWidget | undefined;
    if (first !== undefined && this.automaticFillUrl !== currentUrl) {
      this.automaticFillUrl = currentUrl;
      void first.autoFillPreferredExact();
    }
  }

  private async loadPreferences(): Promise<void> {
    let value: unknown = DEFAULT_UI_PREFERENCES;
    try {
      const stored = await chrome.storage.local.get(UI_PREFERENCES_STORAGE_KEY);
      value = stored[UI_PREFERENCES_STORAGE_KEY];
    } catch {
      // The inline surface remains usable with system defaults.
    }
    const preferences = parseUiPreferences(value);
    const systemLanguage = chrome.i18n?.getUILanguage?.() ?? this.doc.documentElement.lang;
    this.locale = resolveUiLocale(preferences.language, systemLanguage);
    this.theme = preferences.theme;
    for (const widget of this.widgets.values()) widget.refreshPreferences();
  }
}

interface InlineWidgetOptions {
  readonly doc: Document;
  readonly input: HTMLInputElement;
  readonly loginTarget: LoginTarget;
  readonly loginTargetId: string;
  readonly documentId: string;
  readonly send: Send;
  readonly locale: () => UiLocale;
  readonly theme: () => "light" | "dark";
  readonly closeOthers: () => void;
}

class InlineWidget {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private openGeneration = 0;
  private automaticFillInFlight = false;
  private automaticFillRetryRequested = false;
  private automaticFillCompleted = false;
  private suggestionGeneration = 0;
  private suggestionsInFlight: Promise<unknown> | null = null;
  private destroyed = false;

  constructor(private readonly options: InlineWidgetOptions) {
    this.host = options.doc.createElement("palladin-autofill");
    this.host.setAttribute("data-palladin-inline", "");
    this.host.style.setProperty("all", "initial", "important");
    // `all: initial !important` is the page-isolation boundary, but it also
    // resets typography. Re-apply Palladin's UI stack at the same priority so
    // hostile or unusual page fonts can never leak into the closed surface.
    this.host.style.setProperty(
      "font-family",
      'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      "important",
    );
    this.host.style.setProperty("font-size", "16px", "important");
    this.host.style.setProperty("line-height", "1.4", "important");
    this.host.style.setProperty("font-synthesis", "none", "important");
    this.host.style.setProperty("position", "fixed", "important");
    this.host.style.setProperty("z-index", "2147483647", "important");
    this.host.style.setProperty("width", "26px", "important");
    this.host.style.setProperty("height", "26px", "important");
    this.host.style.setProperty("pointer-events", "none", "important");
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = options.doc.createElement("style");
    style.textContent = INLINE_STYLES;
    this.shadow.append(style);
    this.button = options.doc.createElement("button");
    this.button.type = "button";
    this.button.className = "launcher";
    this.button.append(createBrandIcon(options.doc));
    this.panel = options.doc.createElement("div");
    this.panel.className = "panel";
    this.panel.hidden = true;
    this.shadow.append(this.button, this.panel);
  }

  get loginTarget(): LoginTarget {
    return this.options.loginTarget;
  }

  get loginTargetId(): string {
    return this.options.loginTargetId;
  }

  matchesLoginTarget(target: LoginTarget): boolean {
    return target.username === this.options.loginTarget.username
      && target.password === this.options.loginTarget.password
      && target.form === this.options.loginTarget.form;
  }

  mount(): void {
    this.refreshPreferences();
    this.options.doc.documentElement.append(this.host);
    this.options.input.addEventListener("focus", this.handleFocus);
    this.button.addEventListener("pointerdown", (event) => event.preventDefault());
    this.button.addEventListener("click", () => void this.open());
    this.reposition();
    this.options.doc.defaultView?.requestAnimationFrame?.(() => this.reposition());
  }

  destroy(): void {
    this.destroyed = true;
    this.invalidateSuggestions();
    this.options.input.removeEventListener("focus", this.handleFocus);
    this.host.remove();
    this.openGeneration += 1;
  }

  close(): void {
    this.panel.hidden = true;
    this.panel.replaceChildren();
    this.openGeneration += 1;
  }

  invalidateSuggestions(): void {
    this.suggestionGeneration += 1;
    this.suggestionsInFlight = null;
    this.close();
  }

  refreshPreferences(): void {
    this.host.dataset["theme"] = this.options.theme();
    this.button.title = message(this.options.locale(), "inline.open");
    this.button.setAttribute("aria-label", this.button.title);
  }

  reposition(): void {
    const rect = this.options.input.getBoundingClientRect();
    const view = this.options.doc.defaultView;
    if (rect.width < 40 || rect.height < 20 || rect.bottom < 0 || rect.top > (view?.innerHeight ?? 0)) {
      this.host.style.setProperty("display", "none", "important");
      return;
    }
    // Match the visual inset of common password visibility controls: derive a
    // quiet trailing gap from the live control height instead of trusting page
    // padding, which often reserves space for unrelated validation widgets.
    const edgeGap = Math.min(18, Math.max(8, (rect.height - 26) / 2));
    const hostLeft = Math.max(4, rect.right - 26 - edgeGap);
    this.host.style.setProperty("display", "block", "important");
    this.host.style.setProperty("left", `${hostLeft}px`, "important");
    this.host.style.setProperty("top", `${Math.max(4, rect.top + (rect.height - 26) / 2)}px`, "important");

    // Keep the closed-shadow chooser inside the viewport even on narrow login
    // columns or high browser zoom. Coordinates are relative to the launcher.
    const viewportWidth = view?.innerWidth ?? 0;
    if (viewportWidth > 0) {
      const panelWidth = Math.min(356, Math.max(0, viewportWidth - 24));
      const desiredLeft = Math.min(
        Math.max(12, hostLeft + 26 - panelWidth),
        Math.max(12, viewportWidth - panelWidth - 12),
      );
      this.panel.style.left = `${desiredLeft - hostLeft}px`;
    }
  }

  private readonly handleFocus = (): void => {
    // document_start can run before the page's final styles/layout. Always bind
    // the launcher to the live field geometry immediately before showing it.
    this.reposition();
    // Page-authored autofocus must not open UI over the page. Automatic exact-
    // host filling is a separate, one-shot path below; the chooser opens only
    // for an actual browser user activation.
    const activated = this.options.doc.defaultView?.navigator.userActivation?.isActive === true;
    if (activated) void this.open();
  };

  /**
   * Fill once when a standard login form appears. The worker orders exact-host
   * results by session recency first and deterministic first match second.
   * Related sibling hosts remain explicit-only and can never enter this path.
   */
  async autoFillPreferredExact(): Promise<void> {
    if (this.automaticFillCompleted || this.destroyed) return;
    if (this.automaticFillInFlight) {
      this.automaticFillRetryRequested = true;
      return;
    }
    const initialValues = loginValueSnapshot(this.options.loginTarget);
    if (initialValues !== "\u0000") return;
    this.automaticFillInFlight = true;
    try {
      const raw = await this.loadSuggestions();
      if (this.destroyed
        || !isCurrentLoginTarget(this.options.loginTarget)
        || loginValueSnapshot(this.options.loginTarget) !== initialValues) {
        return;
      }
      if (!isInlineAutofillResult(raw) || !raw.ok || raw.kind !== "suggestions") return;
      if (raw.status === "locked" || raw.status === "signed-out") {
        this.showSessionRequired(raw.status);
        return;
      }
      if (raw.status !== "ready") return;
      const preferredExact = raw.entries.find((entry) => entry.match === "exact");
      if (preferredExact !== undefined) {
        this.automaticFillCompleted = await this.fill(preferredExact, false, true);
      }
    } finally {
      this.automaticFillInFlight = false;
      if (this.automaticFillRetryRequested && !this.automaticFillCompleted && !this.destroyed) {
        this.automaticFillRetryRequested = false;
        void this.autoFillPreferredExact();
      }
    }
  }

  private async loadSuggestions(): Promise<unknown> {
    if (this.suggestionsInFlight !== null) return this.suggestionsInFlight;
    const generation = this.suggestionGeneration;
    const request = (async (): Promise<unknown> => {
      try {
        const raw = await this.options.send({
          channel: INLINE_AUTOFILL_CHANNEL,
          type: "inline/list",
          documentId: this.options.documentId,
        });
        if (generation !== this.suggestionGeneration) return null;
        return raw;
      } catch {
        return null;
      }
    })();
    this.suggestionsInFlight = request;
    try {
      return await request;
    } finally {
      if (this.suggestionsInFlight === request) this.suggestionsInFlight = null;
    }
  }

  private async open(): Promise<void> {
    this.options.closeOthers();
    this.panel.hidden = false;
    const generation = ++this.openGeneration;
    this.renderLoading();
    const raw = await this.loadSuggestions();
    if (generation !== this.openGeneration) return;
    if (!isInlineAutofillResult(raw) || !raw.ok || raw.kind !== "suggestions") {
      this.renderStatus("inline.unavailable");
      return;
    }
    if (raw.status === "locked") return this.renderSessionRequired("locked");
    if (raw.status === "signed-out") return this.renderSessionRequired("signed-out");
    if (raw.entries.length === 0) return this.renderStatus("inline.empty");
    this.renderSuggestions(raw.entries);
  }

  private showSessionRequired(status: "locked" | "signed-out"): void {
    this.options.closeOthers();
    this.panel.hidden = false;
    this.openGeneration += 1;
    this.renderSessionRequired(status);
  }

  private renderSessionRequired(sessionStatus: "locked" | "signed-out"): void {
    const wrapper = this.options.doc.createElement("div");
    wrapper.className = "session-required";
    const description = this.options.doc.createElement("div");
    description.className = "status";
    description.textContent = message(
      this.options.locale(),
      sessionStatus === "locked" ? "inline.locked" : "inline.signedOut",
    );
    const open = this.options.doc.createElement("button");
    open.type = "button";
    open.className = "open-palladin";
    open.textContent = message(
      this.options.locale(),
      sessionStatus === "locked" ? "inline.unlockPalladin" : "inline.signInPalladin",
    );
    open.addEventListener("click", () => void this.openPalladin());
    wrapper.append(description, open);
    this.panel.replaceChildren(wrapper);
  }

  private async openPalladin(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.options.send({
        channel: INLINE_AUTOFILL_CHANNEL,
        type: "inline/open-palladin",
        documentId: this.options.documentId,
      });
    } catch {
      raw = null;
    }
    if (isInlineAutofillResult(raw) && raw.ok && raw.kind === "surface" && raw.status === "opened") {
      this.close();
      return;
    }
    this.renderStatus("inline.unavailable");
  }

  private renderSuggestions(entries: readonly InlineAutofillSuggestion[]): void {
    const title = this.createTitle();
    const list = this.options.doc.createElement("div");
    list.className = "list";
    for (const entry of entries) {
      const row = this.options.doc.createElement("div");
      row.className = "option-row";
      const option = this.options.doc.createElement("button");
      option.type = "button";
      option.className = "option";
      const text = this.options.doc.createElement("span");
      text.className = "entry-text";
      const primary = this.options.doc.createElement("strong");
      primary.textContent = entry.username || entry.name;
      const label = displayEntryLabel(entry);
      if (label !== null) {
        const name = this.options.doc.createElement("span");
        name.className = "entry-name";
        name.textContent = label;
        text.append(primary, name);
      } else {
        text.append(primary);
      }
      const detail = this.options.doc.createElement("small");
      detail.textContent = suggestionDetail(entry, this.options.locale());
      text.append(detail);
      option.append(text);
      option.addEventListener("click", () => void this.fill(entry));

      const submit = this.options.doc.createElement("button");
      submit.type = "button";
      submit.className = "submit-login";
      submit.title = message(this.options.locale(), "inline.fillAndLogin");
      submit.setAttribute("aria-label", `${submit.title}: ${entry.username || entry.name}`);
      const submitLabel = this.options.doc.createElement("span");
      submitLabel.textContent = message(this.options.locale(), "inline.logIn");
      submit.append(submitLabel);
      submit.addEventListener("click", () => void this.fill(entry, true));
      row.append(option, submit);
      list.append(row);
    }
    this.panel.replaceChildren(title, list);
  }

  private renderLoading(): void {
    const loading = this.options.doc.createElement("div");
    loading.className = "loading";
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", message(this.options.locale(), "inline.loading"));
    for (let index = 0; index < 3; index += 1) {
      const row = this.options.doc.createElement("div");
      row.className = "loading-row";
      const text = this.options.doc.createElement("span");
      text.className = "loading-lines";
      text.append(
        this.options.doc.createElement("i"),
        this.options.doc.createElement("i"),
      );
      const action = this.options.doc.createElement("i");
      action.className = "loading-action";
      row.append(text, action);
      loading.append(row);
    }
    this.panel.replaceChildren(this.createTitle(), loading);
  }

  private createTitle(): HTMLDivElement {
    const title = this.options.doc.createElement("div");
    title.className = "title";
    const titleIcon = createBrandIcon(this.options.doc);
    titleIcon.className = "title-icon";
    const titleText = this.options.doc.createElement("span");
    titleText.textContent = message(this.options.locale(), "inline.title");
    title.append(titleIcon, titleText);
    return title;
  }

  private async fill(
    entry: InlineAutofillSuggestion,
    submitAfterFill = false,
    silent = false,
  ): Promise<boolean> {
    if (!isCurrentLoginTarget(this.options.loginTarget)) {
      if (!silent) this.renderStatus("inline.noForm");
      return false;
    }
    if (!silent) this.renderStatus("inline.filling");
    let raw: unknown;
    try {
      raw = await this.options.send({
        channel: INLINE_AUTOFILL_CHANNEL,
        type: "inline/fill",
        documentId: this.options.documentId,
        vaultId: entry.vaultId,
        entryId: entry.entryId,
        scope: entry.match,
        loginTargetId: this.options.loginTargetId,
      });
    } catch {
      raw = null;
    }
    if (!isInlineAutofillResult(raw) || !raw.ok || raw.kind !== "fill") {
      if (!silent) this.renderStatus("inline.unavailable");
      return false;
    }
    if (raw.status === "filled" && submitAfterFill) {
      submitLoginForm(this.options.loginTarget.password);
    }
    if (!silent) {
      this.renderStatus(raw.status === "filled"
        ? "inline.filled"
        : raw.status === "no-form" ? "inline.noForm" : "inline.blocked");
      if (raw.status === "filled") setTimeout(() => this.close(), 700);
    }
    return raw.status === "filled";
  }

  private renderStatus(key: InlineKey): void {
    const status = this.options.doc.createElement("div");
    status.className = "status";
    status.textContent = message(this.options.locale(), key);
    this.panel.replaceChildren(status);
  }
}

function loginValueSnapshot(target: LoginTarget): string {
  return `${target.username.value}\u0000${target.password.value}`;
}

function message(locale: UiLocale, key: InlineKey): string {
  const catalog = locale === "pl" ? pl : en;
  return catalog[key];
}

export function displayEntryLabel(entry: InlineAutofillSuggestion): string | null {
  const label = entry.name.trim();
  const normalized = label.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  const username = entry.username.trim().toLowerCase();
  const domain = entry.urlDomain.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return label.length === 0 || normalized === username || normalized === domain ? null : label;
}

export function suggestionDetail(entry: InlineAutofillSuggestion, locale: UiLocale): string {
  const vault = `${message(locale, "inline.vault")}: ${entry.vaultName}`;
  return entry.match === "related"
    ? `${message(locale, "inline.related")}: ${entry.urlDomain} · ${vault}`
    : vault;
}

function resolvedTheme(preference: ThemePreference, view: Window | null): "light" | "dark" {
  if (preference === "light" || preference === "dark") return preference;
  return view?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function createBrandIcon(doc: Document): HTMLImageElement {
  const image = doc.createElement("img");
  image.src = palladinIconUrl;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

const INLINE_STYLES = `
  :host { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  :host([data-theme="dark"]) { color-scheme: dark; }
  * { box-sizing: border-box; }
  button { font: inherit; letter-spacing: normal; text-transform:none; }
  .launcher { width:26px; height:26px; padding:2px; border:0; border-radius:8px; background:transparent; box-shadow:none; cursor:pointer; pointer-events:auto; }
  .launcher:hover, .launcher:focus-visible { background:rgba(235,71,71,.1); outline:2px solid rgba(235,71,71,.3); outline-offset:1px; }
  .launcher img { display:block; width:22px; height:22px; object-fit:contain; }
  .panel { position:absolute; top:34px; left:0; width:min(344px, calc(100vw - 24px)); overflow:hidden; border:1px solid rgba(12,14,18,.1); border-radius:15px; background:linear-gradient(160deg,#f7f9fb 0%,#e8ecf1 100%); color:#0c0e12; box-shadow:0 14px 34px rgba(30,42,58,.16); pointer-events:auto; }
  .title { display:flex; align-items:center; gap:9px; padding:12px 14px; color:#3d4e66; font-size:13px; line-height:1.35; font-weight:750; background:transparent; border-bottom:1px solid rgba(12,14,18,.08); }
  .title-icon { display:block; width:20px; height:20px; object-fit:contain; }
  .list { display:flex; flex-direction:column; gap:7px; max-height:264px; overflow:auto; padding:10px; scrollbar-width:thin; scrollbar-color:rgba(61,78,102,.22) transparent; }
  .option-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; min-height:65px; border:1px solid rgba(12,14,18,.08); border-radius:11px; background:#fff; }
  .option-row:hover { border-color:rgba(12,14,18,.14); background:#fff; }
  .option { display:flex; align-items:center; width:100%; min-width:0; min-height:63px; padding:9px 10px; border:0; border-radius:10px 0 0 10px; background:transparent; color:inherit; text-align:left; cursor:pointer; }
  .option:hover { background:rgba(12,14,18,.025); }
  .option:focus-visible { outline:2px solid rgba(235,71,71,.28); outline-offset:-2px; }
  .submit-login { align-self:stretch; display:flex; align-items:center; justify-content:center; gap:5px; min-width:76px; min-height:63px; padding:0 11px; border:0; border-left:1px solid rgba(12,14,18,.08); border-radius:0 10px 10px 0; background:transparent; color:#d95749; box-shadow:none; font-size:11.5px; line-height:1; font-weight:750; cursor:pointer; }
  .submit-login:hover, .submit-login:focus-visible { border-left-color:rgba(219,86,72,.22); background:#fcecea; color:#c9483c; outline:2px solid rgba(219,86,72,.18); outline-offset:-2px; }
  .entry-text { display:flex; flex-direction:column; min-width:0; gap:2px; }
  .entry-text strong, .entry-text .entry-name, .entry-text small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .entry-text strong { font-size:14px; line-height:1.3; font-weight:700; }
  .entry-text .entry-name { color:#4f5d73; font-size:12px; line-height:1.3; }
  .entry-text small { color:#8a95a6; font-size:11px; line-height:1.3; }
  .loading { display:flex; flex-direction:column; gap:7px; padding:10px; }
  .loading-row { display:grid; grid-template-columns:minmax(0,1fr) 58px; align-items:center; min-height:65px; padding:10px; border:1px solid rgba(12,14,18,.06); border-radius:11px; background:rgba(255,255,255,.72); }
  .loading-lines { display:flex; flex-direction:column; gap:7px; }
  .loading-lines i, .loading-action { display:block; border-radius:999px; background:rgba(61,78,102,.12); animation:palladin-loading 1.15s ease-in-out infinite alternate; }
  .loading-lines i:first-child { width:52%; height:11px; }
  .loading-lines i:last-child { width:34%; height:8px; }
  .loading-action { width:54px; height:30px; }
  @keyframes palladin-loading { from { opacity:.42; } to { opacity:.88; } }
  @media (prefers-reduced-motion:reduce) { .loading-lines i, .loading-action { animation:none; } }
  .status { padding:15px 13px; color:#5a6478; font-size:14px; line-height:1.45; }
  .session-required { display:grid; gap:8px; padding:12px; }
  .session-required .status { padding:0; }
  .open-palladin { min-height:36px; border:0; border-radius:8px; background:#EB4747; color:#fff; font:600 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif; cursor:pointer; }
  .open-palladin:hover, .open-palladin:focus-visible { background:#d63c3c; outline:2px solid rgba(235,71,71,.35); outline-offset:2px; }
  :host([data-theme="dark"]) .panel { background:linear-gradient(160deg,#1f232b 0%,#16191f 100%); color:#e8eaed; border-color:rgba(232,234,237,.1); box-shadow:0 16px 40px rgba(0,0,0,.34); }
  :host([data-theme="dark"]) .launcher:hover, :host([data-theme="dark"]) .launcher:focus-visible { background:rgba(235,71,71,.18); }
  :host([data-theme="dark"]) .title { color:#d5dbe4; border-color:rgba(232,234,237,.09); }
  :host([data-theme="dark"]) .option-row { border-color:rgba(232,234,237,.1); background:rgba(232,234,237,.05); }
  :host([data-theme="dark"]) .option-row:hover { border-color:rgba(232,234,237,.17); background:rgba(232,234,237,.07); }
  :host([data-theme="dark"]) .option:hover { background:rgba(232,234,237,.035); }
  :host([data-theme="dark"]) .submit-login { border-left-color:rgba(232,234,237,.1); background:transparent; color:#ef8a7e; }
  :host([data-theme="dark"]) .submit-login:hover, :host([data-theme="dark"]) .submit-login:focus-visible { border-left-color:rgba(239,126,112,.28); background:rgba(219,86,72,.16); color:#f29a90; }
  :host([data-theme="dark"]) .entry-text .entry-name { color:#c4ccd8; }
  :host([data-theme="dark"]) .status { color:#b8c5d4; }
  :host([data-theme="dark"]) .loading-row { border-color:rgba(232,234,237,.08); background:rgba(232,234,237,.04); }
  :host([data-theme="dark"]) .loading-lines i, :host([data-theme="dark"]) .loading-action { background:rgba(232,234,237,.14); }
`;
