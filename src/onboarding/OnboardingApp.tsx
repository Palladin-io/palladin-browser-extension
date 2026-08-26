import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import brandLogoUrl from "../../icons/logo-source.png";
import type { SessionStatus } from "../background/session/types";
import { extensionBuildTarget, type ExtensionBuildTarget } from "@shared/config/build-target";
import { PRODUCTION_API_URL, normalizeServerUrl } from "@shared/config/server";
import { webAppUrl } from "@shared/config/web-app";
import { createServerConfigClient, ServerConfigClientError, type ServerConfigClient } from "../popup/config/client";
import { useI18n, type Translate, type TranslationKey } from "../popup/i18n";
import {
  createPasswordManagerOnboardingClient,
  extensionManagerHelpUrl,
  type PasswordManagerOnboardingClient,
} from "../popup/onboarding/client";
import {
  usePopupPreferences,
  type LanguagePreference,
  type ThemePreference,
} from "../popup/preferences";
import { createSessionClient, type SessionClient } from "../popup/session/client";

type OnboardingStep = 0 | 1 | 2;

type FooterLink = Readonly<{
  label: TranslationKey;
  url: string | null;
}>;

const publicBuildEnv = import.meta.env as unknown as Record<string, string | undefined>;
const landingPageUrl = optionalHttpsUrl(publicBuildEnv["VITE_LANDING_PAGE_URL"]) ?? "https://palladin.io";
const appStoreUrl = optionalHttpsUrl(publicBuildEnv["VITE_APP_STORE_URL"]);
const googlePlayUrl = optionalHttpsUrl(publicBuildEnv["VITE_GOOGLE_PLAY_URL"]);
type GlyphName = "pin" | "account" | "import" | "shield" | "check" | "arrow" | "server" | "theme";

interface BrowserActions {
  openExtension(): Promise<void>;
  openExternal(url: string): Promise<void>;
  openWebPanel(path: string): Promise<void>;
}

export interface OnboardingAppProps {
  target?: ExtensionBuildTarget;
  sessionClient?: Pick<SessionClient, "getStatus">;
  serverClient?: ServerConfigClient;
  onboardingClient?: Pick<PasswordManagerOnboardingClient, "complete" | "openExtensionManager">;
  browserActions?: BrowserActions;
}

const STEPS: ReadonlyArray<{
  readonly shortTitle: TranslationKey;
}> = [
  { shortTitle: "onboarding.page.pin.short" },
  { shortTitle: "onboarding.page.account.short" },
  { shortTitle: "onboarding.page.import.short" },
];

export function OnboardingApp({
  target = extensionBuildTarget,
  sessionClient,
  serverClient,
  onboardingClient,
  browserActions,
}: OnboardingAppProps): React.JSX.Element {
  const { t } = useI18n();
  const preferences = usePopupPreferences();
  const sessions = useMemo(() => sessionClient ?? createSessionClient(), [sessionClient]);
  const servers = useMemo(
    () => serverClient ?? createOnboardingServerClient(),
    [serverClient],
  );
  const onboarding = useMemo(
    () => onboardingClient ?? createPasswordManagerOnboardingClient(target),
    [onboardingClient, target],
  );
  const browser = useMemo(() => browserActions ?? createBrowserActions(), [browserActions]);
  const [step, setStep] = useState<OnboardingStep>(0);
  const [furthestStep, setFurthestStep] = useState<OnboardingStep>(0);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | "unavailable">("unavailable");
  const [actionError, setActionError] = useState("");
  const [finished, setFinished] = useState(false);

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      setSessionStatus(await sessions.getStatus());
    } catch {
      setSessionStatus("unavailable");
    }
  }, [sessions]);

  useEffect(() => {
    void refreshSession();
    const onFocus = (): void => { void refreshSession(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshSession]);

  useEffect(() => {
    if (step !== 1) return;

    // This full-page flow replaces the legacy popup guidance. Persist its
    // marker before the user asks to sign in, so opening extension-owned UI
    // can remain the first awaited browser call and retain user activation.
    void onboarding.complete().catch(() => {
      setActionError(t("onboarding.page.account.openError"));
    });
  }, [onboarding, step, t]);

  function goToStep(next: OnboardingStep): void {
    setStep(next);
    setFurthestStep((current) => Math.max(current, next) as OnboardingStep);
    setActionError("");
  }

  async function openExtension(): Promise<void> {
    setActionError("");
    try {
      // Browser-owned popup APIs require the call to stay within the original
      // user gesture. Do not await storage or any other work before this call.
      await browser.openExtension();
      await onboarding.complete();
    } catch {
      setActionError(t("onboarding.page.account.openError"));
    }
  }

  async function openPanel(path: string): Promise<void> {
    setActionError("");
    try {
      await browser.openWebPanel(path);
    } catch {
      setActionError(t("onboarding.page.panelOpenError"));
    }
  }

  async function openExtensionManager(): Promise<void> {
    try {
      await onboarding.openExtensionManager();
    } catch {
      await browser.openExternal(extensionManagerHelpUrl(target));
    }
  }

  async function finish(): Promise<void> {
    setActionError("");
    try {
      await onboarding.complete();
      setFinished(true);
    } catch {
      setActionError(t("onboarding.page.finishError"));
    }
  }

  if (finished) {
    return (
      <main className="onboarding onboarding--complete">
        <TopBar compact preferences={preferences} />
        <section className="completion" aria-labelledby="completion-title">
          <div className="completion-emblem" aria-hidden="true">
            <img className="completion-logo" src={brandLogoUrl} alt="" />
          </div>
          <h1 id="completion-title" aria-label="Palladin.io">
            Palladin<span className="completion-title__domain">.io</span>
          </h1>
          <p>{t("onboarding.page.complete.subtitle")}</p>
          <button className="button button--accent" type="button" onClick={() => void openExtension()}>
            {t("onboarding.page.complete.open")}
            <Glyph name="arrow" />
          </button>
          {actionError ? <p className="inline-feedback inline-feedback--error" role="alert">{actionError}</p> : null}
        </section>
        <OnboardingFooter t={t} />
      </main>
    );
  }

  return (
    <main className="onboarding">
      <TopBar preferences={preferences} />
      <div className="onboarding-shell">
        <header className="hero">
          <h1>{t("onboarding.page.title")}</h1>
          <p>{t("onboarding.page.subtitle")}</p>
        </header>

        <div className="onboarding-panel">
          <nav className="stepper" aria-label={t("onboarding.page.progressLabel")}>
            <ol>
              {STEPS.map((item, index) => {
                const isCurrent = step === index;
                const isDone = index < step || index < furthestStep;
                return (
                  <li key={item.shortTitle} className={isCurrent ? "is-current" : isDone ? "is-done" : ""}>
                    <button
                      type="button"
                      aria-current={isCurrent ? "step" : undefined}
                      aria-label={`${t("onboarding.page.step", { current: index + 1, total: STEPS.length })}: ${t(item.shortTitle)}`}
                      onClick={() => goToStep(index as OnboardingStep)}
                    >
                      <span className="stepper__index" aria-hidden="true">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="stepper__copy">
                        <strong>{t(item.shortTitle)}</strong>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section className="stage" aria-labelledby="stage-title">
            <div className="stage__content">
              {step === 0 ? (
                <PinStep
                  target={target}
                  t={t}
                  onOpenManager={openExtensionManager}
                  onContinue={() => goToStep(1)}
                />
              ) : step === 1 ? (
                <AccountStep
                  t={t}
                  status={sessionStatus}
                  serverClient={servers}
                  onServerChanged={refreshSession}
                  onOpenExtension={openExtension}
                  onBack={() => goToStep(0)}
                  onContinue={() => goToStep(2)}
                />
              ) : (
                <ImportStep
                  t={t}
                  onOpenPanel={() => openPanel("/vaults?intent=import")}
                  onBack={() => goToStep(1)}
                  onFinish={finish}
                />
              )}
              {actionError ? <p className="inline-feedback inline-feedback--error" role="alert">{actionError}</p> : null}
            </div>
            <StepVisual
              step={step}
              t={t}
              connected={sessionStatus === "locked" || sessionStatus === "unlocked"}
            />
          </section>
        </div>
      </div>
      <OnboardingFooter t={t} />
    </main>
  );
}

function optionalHttpsUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function OnboardingFooter({ t }: { t: Translate }): React.JSX.Element {
  const links: ReadonlyArray<FooterLink> = [
    { label: "onboarding.page.footer.webPanel", url: webAppUrl },
    { label: "onboarding.page.footer.landing", url: landingPageUrl },
    { label: "onboarding.page.footer.appStore", url: appStoreUrl },
    { label: "onboarding.page.footer.googlePlay", url: googlePlayUrl },
  ];

  return (
    <footer className="onboarding-footer">
      <div className="onboarding-footer__inner">
        <a className="onboarding-footer__brand" href={landingPageUrl} target="_blank" rel="noreferrer">
          <img src={brandLogoUrl} alt="" aria-hidden="true" />
          <span>Palladin<span>.io</span></span>
        </a>
        <span className="onboarding-footer__tagline">{t("onboarding.page.footerEncryption")}</span>
        <nav className="onboarding-footer__links" aria-label={t("onboarding.page.footer.navigationLabel")}>
          {links.map((link) => link.url ? (
            <a key={link.label} href={link.url} target="_blank" rel="noreferrer">{t(link.label)}</a>
          ) : (
            <span key={link.label} aria-disabled="true" title={t("onboarding.page.footer.comingSoon")}>
              {t(link.label)}
            </span>
          ))}
        </nav>
        <span className="onboarding-footer__copy">
          © {new Date().getFullYear()} Palladin
        </span>
      </div>
    </footer>
  );
}

function TopBar({
  preferences,
  compact = false,
}: {
  preferences: ReturnType<typeof usePopupPreferences>;
  compact?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const themes: ReadonlyArray<{ value: ThemePreference; icon: string; label: TranslationKey }> = [
    { value: "system", icon: "◐", label: "settings.theme.system" },
    { value: "light", icon: "☼", label: "settings.theme.light" },
    { value: "dark", icon: "☾", label: "settings.theme.dark" },
  ];
  return (
    <header className={`topbar${compact ? " topbar--compact" : ""}`}>
      <a className="onboarding-brand" href={webAppUrl} target="_blank" rel="noreferrer" aria-label="Palladin.io">
        <img src={brandLogoUrl} alt="" aria-hidden="true" />
        <span>Palladin<span>.io</span></span>
      </a>
      <div className="topbar__controls">
        <label className="language-control">
          <span className="sr-only">{t("settings.language")}</span>
          <select
            value={preferences.language}
            aria-label={t("settings.language")}
            onChange={(event) => void preferences.setLanguage(event.target.value as LanguagePreference)}
          >
            <option value="system">{t("settings.language.system")}</option>
            <option value="en">EN</option>
            <option value="pl">PL</option>
          </select>
        </label>
        <div className="theme-control" role="group" aria-label={t("settings.theme")}>
          {themes.map((item) => (
            <button
              key={item.value}
              type="button"
              className={preferences.theme === item.value ? "is-active" : ""}
              aria-label={t(item.label)}
              aria-pressed={preferences.theme === item.value}
              onClick={() => void preferences.setTheme(item.value)}
            >
              <span aria-hidden="true">{item.icon}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function PinStep({
  target,
  t,
  onOpenManager,
  onContinue,
}: {
  target: ExtensionBuildTarget;
  t: Translate;
  onOpenManager(): Promise<void>;
  onContinue(): void;
}): React.JSX.Element {
  const instructionKeys = pinInstructionKeys(target);
  const [error, setError] = useState("");
  async function openManager(): Promise<void> {
    setError("");
    try {
      await onOpenManager();
    } catch {
      setError(t("onboarding.managers.openError"));
    }
  }
  return (
    <div className="step-copy step-enter">
      <span className="stage__eyebrow">{t("onboarding.page.step", { current: 1, total: 3 })}</span>
      <h2 id="stage-title">{t("onboarding.page.pin.title")}</h2>
      <p className="stage__lead">{t("onboarding.page.pin.subtitle")}</p>
      <ol className="instruction-list">
        {instructionKeys.map((key, index) => (
          <li key={key}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <p>{t(key)}</p>
          </li>
        ))}
      </ol>
      {error ? <p className="inline-feedback inline-feedback--error" role="alert">{error}</p> : null}
      <div className="stage__actions">
        <button className="button button--subtle" type="button" onClick={() => void openManager()}>
          {t("onboarding.managers.openExtensions")}
        </button>
        <button className="button button--accent" type="button" onClick={onContinue}>
          {t("onboarding.page.continue")}
          <Glyph name="arrow" />
        </button>
      </div>
    </div>
  );
}

function AccountStep({
  t,
  status,
  serverClient,
  onServerChanged,
  onOpenExtension,
  onBack,
  onContinue,
}: {
  t: Translate;
  status: SessionStatus | "unavailable";
  serverClient: ServerConfigClient;
  onServerChanged(): Promise<void>;
  onOpenExtension(): Promise<void>;
  onBack(): void;
  onContinue(): void;
}): React.JSX.Element {
  const connected = status === "locked" || status === "unlocked";
  return (
    <div className="step-copy step-enter">
      <span className="stage__eyebrow">{t("onboarding.page.step", { current: 2, total: 3 })}</span>
      <h2 id="stage-title">{t("onboarding.page.account.title")}</h2>
      <p className="stage__lead">{t("onboarding.page.account.subtitle")}</p>
      <div className="account-settings">
        <div className={`connection-status${connected ? " is-connected" : ""}`} role="status">
          <span className="account-setting__icon"><Glyph name={connected ? "check" : "account"} /></span>
          <div>
            <strong>{t(connected ? "onboarding.page.account.connected" : "onboarding.page.account.notConnected")}</strong>
            <p>{t(connected ? "onboarding.page.account.connectedHint" : "onboarding.page.account.notConnectedHint")}</p>
          </div>
        </div>
        <ServerSetup client={serverClient} t={t} onChanged={onServerChanged} />
      </div>
      <div className="account-actions">
        <button className="button button--subtle" type="button" onClick={() => void onOpenExtension()}>
          {t(connected ? "onboarding.page.account.open" : "onboarding.page.account.connect")}
          <Glyph name="arrow" />
        </button>
      </div>
      <div className="stage__actions stage__actions--split">
        <button className="button button--ghost" type="button" onClick={onBack}>{t("common.back")}</button>
        <button className="button button--accent" type="button" onClick={onContinue}>
          {t("onboarding.page.continue")}
          <Glyph name="arrow" />
        </button>
      </div>
    </div>
  );
}

function ServerSetup({
  client,
  t,
  onChanged,
}: {
  client: ServerConfigClient;
  t: Translate;
  onChanged(): Promise<void>;
}): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState(PRODUCTION_API_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const translateRef = useRef(t);
  translateRef.current = t;

  useEffect(() => {
    let active = true;
    void client.get().then((status) => {
      if (!active) return;
      setCurrent(status.apiUrl);
      setInput(status.apiUrl);
      setEnabled(status.apiUrl !== PRODUCTION_API_URL);
    }).catch(() => {
      if (active) setError(translateRef.current("settings.server.readError"));
    });
    return () => { active = false; };
  }, [client]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    const requested = enabled ? input : PRODUCTION_API_URL;
    if (normalizeServerUrl(requested) === null || current === null || busy) {
      setError(t("settings.server.invalid"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await client.save(requested);
      setCurrent(result.apiUrl);
      setInput(result.apiUrl);
      setEnabled(result.apiUrl !== PRODUCTION_API_URL);
      setNotice(t(result.changed ? "settings.server.updated" : "settings.server.unchanged"));
      if (result.changed) await onChanged();
    } catch (cause) {
      setError(serverError(cause, t));
    } finally {
      setBusy(false);
    }
  }

  async function toggleServerMode(): Promise<void> {
    setError("");
    setNotice("");
    if (!enabled || current === null || current === PRODUCTION_API_URL) {
      setEnabled((value) => !value);
      return;
    }

    setBusy(true);
    try {
      const result = await client.save(PRODUCTION_API_URL);
      setCurrent(result.apiUrl);
      setInput(result.apiUrl);
      setEnabled(false);
      setNotice(t(result.changed ? "settings.server.updated" : "settings.server.unchanged"));
      if (result.changed) await onChanged();
    } catch (cause) {
      setError(serverError(cause, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`server-setup${enabled ? " is-open" : ""}`}>
      <div className="server-setup__heading">
        <span className="account-setting__icon"><Glyph name="server" /></span>
        <div>
          <strong>{t("onboarding.page.server.title")}</strong>
          <p>{t("onboarding.page.server.subtitle")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("onboarding.page.server.toggle")}
          className="switch"
          disabled={current === null || busy}
          onClick={() => void toggleServerMode()}
        >
          <span />
        </button>
      </div>
      {enabled ? (
        <form className="server-setup__form" onSubmit={save} noValidate>
          <label htmlFor="onboarding-server">{t("settings.server.url")}</label>
          <div className="server-input-row">
            <input
              id="onboarding-server"
              type="url"
              inputMode="url"
              spellCheck={false}
              autoComplete="url"
              value={input}
              placeholder="https://api.example.com"
              disabled={current === null || busy}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => {
                setInput(event.target.value);
                setError("");
                setNotice("");
              }}
            />
            <button className="button button--subtle button--compact" type="submit" disabled={current === null || busy}>
              {busy ? t("onboarding.page.server.saving") : t("settings.server.save")}
            </button>
          </div>
          <p className="server-setup__warning">{t("settings.server.warning")}</p>
        </form>
      ) : null}
      {error ? <p className="server-setup__feedback inline-feedback inline-feedback--error" role="alert">{error}</p> : null}
      {notice ? <p className="server-setup__feedback inline-feedback inline-feedback--success" role="status">{notice}</p> : null}
    </div>
  );
}

function ImportStep({
  t,
  onOpenPanel,
  onBack,
  onFinish,
}: {
  t: Translate;
  onOpenPanel(): Promise<void>;
  onBack(): void;
  onFinish(): Promise<void>;
}): React.JSX.Element {
  return (
    <div className="step-copy step-copy--import step-enter">
      <span className="stage__eyebrow">{t("onboarding.page.step", { current: 3, total: 3 })}</span>
      <h2 id="stage-title">{t("onboarding.page.import.title")}</h2>
      <p className="stage__lead">{t("onboarding.page.import.subtitle")}</p>
      <div className="import-panel">
        <div>
          <strong>{t("onboarding.page.import.panelTitle")}</strong>
          <p>{t("onboarding.page.import.panelSubtitle")}</p>
        </div>
        <button className="button button--subtle" type="button" onClick={() => void onOpenPanel()}>
          {t("onboarding.page.import.openPanel")}
          <Glyph name="arrow" />
        </button>
      </div>
      <p className="local-encryption-note"><Glyph name="shield" />{t("onboarding.page.import.security")}</p>
      <div className="stage__actions stage__actions--split">
        <button className="button button--ghost" type="button" onClick={onBack}>{t("common.back")}</button>
        <button className="button button--accent" type="button" onClick={() => void onFinish()}>
          {t("onboarding.page.finish")}
          <Glyph name="check" />
        </button>
      </div>
    </div>
  );
}

function StepVisual({
  step,
  t,
  connected,
}: {
  step: OnboardingStep;
  t: Translate;
  connected: boolean;
}): React.JSX.Element {
  return (
    <div className={`step-visual step-visual--${step + 1}`} aria-hidden="true">
      <div className="step-visual__glow" />
      {step === 0 ? (
        <div className="browser-visual">
          <div className="browser-visual__bar">
            <span /><span /><span />
            <div className="browser-visual__address" />
            <div className="browser-visual__extension"><Glyph name="pin" /></div>
          </div>
          <div className="browser-visual__body">
            <div className="browser-visual__hint"><span>1</span>{t("onboarding.page.visual.extensions")}</div>
            <div className="extension-menu-card">
              <div className="extension-menu-card__brand">
                <img src={brandLogoUrl} alt="" />
                <strong>Palladin.io</strong>
              </div>
              <span className="pin-button"><Glyph name="pin" /></span>
            </div>
            <div className="browser-visual__hint browser-visual__hint--last"><span>2</span>{t("onboarding.page.visual.pin")}</div>
          </div>
        </div>
      ) : step === 1 ? (
        <div className={`account-visual${connected ? " is-connected" : ""}`}>
          <div className="secure-orbit secure-orbit--outer" />
          <div className="secure-orbit secure-orbit--inner" />
          <div className="account-visual__logo"><img src={brandLogoUrl} alt="" /></div>
          <div className="account-card account-card--top"><Glyph name="shield" /><span>{t("onboarding.page.visual.encrypted")}</span></div>
          <div className={`account-card account-card--bottom${connected ? " is-connected" : ""}`}>
            <Glyph name={connected ? "check" : "account"} />
            <span>{t(connected ? "onboarding.page.visual.connected" : "onboarding.page.visual.notConnected")}</span>
          </div>
        </div>
      ) : (
        <div className="import-visual">
          <div className="import-source import-source--one">••••••••</div>
          <div className="import-source import-source--two">••••••••</div>
          <div className="import-source import-source--three">••••••••</div>
          <div className="import-flow"><Glyph name="arrow" /></div>
          <div className="vault-card">
            <span><Glyph name="shield" /></span>
            <strong>{t("onboarding.page.visual.vault")}</strong>
            <small>{t("onboarding.page.visual.local")}</small>
          </div>
        </div>
      )}
    </div>
  );
}

function pinInstructionKeys(target: ExtensionBuildTarget): TranslationKey[] {
  switch (target) {
    case "firefox":
      return [
        "onboarding.page.pin.firefox.one",
        "onboarding.page.pin.firefox.two",
        "onboarding.page.pin.firefox.three",
      ];
    case "safari":
      return [
        "onboarding.page.pin.safari.one",
        "onboarding.page.pin.safari.two",
        "onboarding.page.pin.safari.three",
      ];
    case "chromium":
      return [
        "onboarding.page.pin.chromium.one",
        "onboarding.page.pin.chromium.two",
        "onboarding.page.pin.chromium.three",
      ];
  }
}

function serverError(error: unknown, t: Translate): string {
  if (error instanceof ServerConfigClientError) {
    if (error.code === "invalid-server") return t("settings.server.invalid");
    if (error.code === "permission-denied") return t("settings.server.permission");
  }
  return t("settings.server.updateError");
}

function createBrowserActions(): BrowserActions {
  return {
    async openExtension() {
      if (typeof chrome === "undefined" || !chrome.action?.openPopup) {
        throw new Error("extension action unavailable");
      }
      await chrome.action.openPopup();
    },
    async openExternal(url) {
      if (typeof chrome !== "undefined" && chrome.tabs?.create) {
        await chrome.tabs.create({ url, active: true });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
    async openWebPanel(path) {
      const url = `${webAppUrl}${path}`;
      if (typeof chrome !== "undefined" && chrome.tabs?.create) {
        await chrome.tabs.create({ url, active: true });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
  };
}

function createOnboardingServerClient(): ServerConfigClient {
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    return createServerConfigClient();
  }

  // Standalone Vite preview has no extension worker. Keeping this state in
  // memory makes the design preview usable without pretending it was saved.
  let apiUrl = PRODUCTION_API_URL;
  return {
    async get() {
      return { apiUrl, changed: false };
    },
    async save(input) {
      const normalized = normalizeServerUrl(input);
      if (normalized === null) throw new ServerConfigClientError("invalid-server");
      const changed = normalized !== apiUrl;
      apiUrl = normalized;
      return { apiUrl, changed };
    },
  };
}

function Glyph({ name }: { name: GlyphName }): React.JSX.Element {
  const paths: Record<GlyphName, React.JSX.Element> = {
    pin: <><path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z" /><path d="M12 13v8" /></>,
    account: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
    import: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    shield: <path d="M12 3 5 6v5c0 4.8 2.8 8.1 7 10 4.2-1.9 7-5.2 7-10V6l-7-3Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    server: <><rect x="4" y="4" width="16" height="6" rx="2" /><rect x="4" y="14" width="16" height="6" rx="2" /><path d="M8 7h.01M8 17h.01" /></>,
    theme: <path d="M12 3a9 9 0 1 0 9 9c-5 2-10-3-9-9Z" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
