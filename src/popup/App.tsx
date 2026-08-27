/**
 * Popup root: a small state machine over the worker's session status. It shows
 * exactly one of sign-in / TOTP / unlock / unlocked, driven by the phase from
 * {@link useSession}. The session client is injectable so the whole flow is
 * testable against a fake command channel, with no live `chrome`.
 */

import { useEffect, useMemo, useState } from "react";

import { createAgentPairingClient, type AgentPairingClient } from "./agent/client";
import { Button } from "./components/Button";
import { Header } from "./components/Header";
import { Spinner } from "./components/Spinner";
import { createServerConfigClient, type ServerConfigClient } from "./config/client";
import { useI18n } from "./i18n";
import {
  createPasswordManagerOnboardingClient,
  type PasswordManagerOnboardingClient,
  type PasswordManagerOnboardingStatus,
} from "./onboarding/client";
import { createSessionClient, type SessionClient } from "./session/client";
import { startSurfaceSessionLiveness } from "./session/surface-liveness";
import { useSession, type SessionPhase } from "./session/useSession";
import { PasswordManagerIntro } from "./screens/PasswordManagerIntro";
import { SignInScreen } from "./screens/SignInScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TotpScreen } from "./screens/TotpScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { UnlockedScreen } from "./screens/UnlockedScreen";
import type { SessionStatus } from "../background/session/types";
import { extensionBuildTarget } from "@shared/config/build-target";
import { openSidePanel, supportsSidePanel } from "@shared/browser/side-panel";
import { isSurfaceStateEvent } from "@shared/messaging";
import { webAppUrl } from "@shared/config/web-app";

export type ExtensionSurface = "popup" | "side-panel";

export interface AppProps {
  /** Injected in tests; defaults to the real `chrome.runtime` channel. */
  client?: SessionClient;
  /** Injected in tests; defaults to the pairing command channel. */
  pairingClient?: AgentPairingClient;
  /** Injected in tests; defaults to the server configuration channel. */
  serverConfigClient?: ServerConfigClient;
  /** Injected in tests; defaults to the versioned local first-run marker. */
  onboardingClient?: PasswordManagerOnboardingClient;
  /** Popup stays compact; the side panel reuses the same state machine at full height. */
  surface?: ExtensionSurface;
  /** Injected in tests; defaults to opening web registration in a browser tab. */
  onCreateAccount?: () => Promise<void>;
}

/** The header chip mirrors the lock state; hidden while the phase is unknown. */
function headerStatus(phase: SessionPhase): SessionStatus | undefined {
  switch (phase) {
    case "unlocked":
      return "unlocked";
    case "locked":
      return "locked";
    case "signed-out":
    case "totp":
      return "signed-out";
    default:
      return undefined;
  }
}

export function App({
  client,
  pairingClient,
  serverConfigClient,
  onboardingClient,
  surface = "popup",
  onCreateAccount = openRegistration,
}: AppProps): React.JSX.Element {
  const { t } = useI18n();
  const sessionClient = useMemo(() => client ?? createSessionClient(), [client]);
  const runtimeClient = useMemo(
    () => pairingClient ?? createAgentPairingClient(),
    [pairingClient],
  );
  const serverClient = useMemo(
    () => serverConfigClient ?? createServerConfigClient(),
    [serverConfigClient],
  );
  const passwordManagerIntroClient = useMemo(
    () => onboardingClient ?? createPasswordManagerOnboardingClient(),
    [onboardingClient],
  );
  const session = useSession(sessionClient);
  const [onboardingStatus, setOnboardingStatus] = useState<
    PasswordManagerOnboardingStatus | "loading"
  >("loading");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vaultViewRevision, setVaultViewRevision] = useState(0);
  const panelAvailable = surface === "popup" && supportsSidePanel(extensionBuildTarget);

  useEffect(() => {
    let active = true;
    setOnboardingStatus("loading");
    void passwordManagerIntroClient.getStatus()
      .then((status) => {
        if (active) setOnboardingStatus(status);
      })
      .catch(() => {
        if (active) setOnboardingStatus("completed");
      });
    return () => { active = false; };
  }, [passwordManagerIntroClient]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
    const onMessage = (raw: unknown): void => {
      if (!isSurfaceStateEvent(raw)) return;
      if (raw.type === "surface/session-changed") session.synchronize(raw.status);
      setVaultViewRevision((revision) => revision + 1);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        // Reloading/uninstalling the extension invalidates an already-open surface.
      }
    };
  }, [session.synchronize]);

  useEffect(() => {
    if (surface !== "side-panel" || typeof chrome === "undefined" || !chrome.tabs) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => setVaultViewRevision((revision) => revision + 1), 120);
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (changeInfo.status === "complete" && tab.active) refresh();
    };
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      if (timer !== null) clearTimeout(timer);
      try {
        chrome.tabs.onActivated.removeListener(refresh);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch {
        // A side panel from the previous extension generation cannot unsubscribe.
      }
    };
  }, [surface]);

  useEffect(() => {
    if (surface !== "side-panel" || session.phase !== "unlocked"
      || typeof chrome === "undefined" || !chrome.runtime?.connect) return;
    const liveness = startSurfaceSessionLiveness(
      chrome.runtime,
      undefined,
      () => Boolean(chrome.runtime.id),
    );
    return () => liveness.stop();
  }, [session.phase, surface]);

  return (
    <main className="popup" data-surface={surface}>
      <Header
        status={onboardingStatus === "completed" ? headerStatus(session.phase) : undefined}
        contextLabel={onboardingStatus === "pending"
          ? "onboarding.managers.eyebrow"
          : undefined}
        settingsOpen={settingsOpen}
        {...(onboardingStatus === "completed"
          ? { onToggleSettings: () => setSettingsOpen((open) => !open) }
          : {})}
      />
      {onboardingStatus === "loading" ? (
        <div className="centered">
          <Spinner />
          <span className="muted">{t("app.preparing")}</span>
        </div>
      ) : onboardingStatus === "pending" ? (
        <PasswordManagerIntro
          onContinue={completePasswordManagerIntro}
          onOpenPasswordSettings={passwordManagerIntroClient.openPasswordSettings}
          onOpenExtensionManager={passwordManagerIntroClient.openExtensionManager}
        />
      ) : settingsOpen ? (
        <SettingsScreen
          serverClient={serverClient}
          pairingClient={runtimeClient}
          onServerChanged={session.retryInit}
        />
      ) : renderPhase()}
    </main>
  );

  async function completePasswordManagerIntro(): Promise<void> {
    try {
      await passwordManagerIntroClient.complete();
    } catch {
      // Guidance must never block access when browser-owned UI storage is unavailable.
    }
    setOnboardingStatus("completed");
  }

  function renderPhase(): React.JSX.Element {
    switch (session.phase) {
      case "loading":
        return (
          <div className="centered">
            <Spinner />
            <span className="muted">{t("app.checkingSession")}</span>
          </div>
        );
      case "unavailable":
        return (
          <div className="centered">
            <span className="muted">{t("app.backgroundUnavailable")}</span>
            <Button variant="subtle" onClick={session.retryInit}>
              {t("common.tryAgain")}
            </Button>
          </div>
        );
      case "signed-out":
        return <SignInScreen onSignIn={session.signIn} onCreateAccount={onCreateAccount} />;
      case "totp":
        return <TotpScreen onSubmitTotp={session.submitTotp} onBack={session.cancelTotp} />;
      case "locked":
        return (
          <UnlockScreen
            onUnlock={session.unlock}
            onSignOut={session.signOut}
            biometricAvailable={session.capabilities?.runtimeUnlock ?? false}
          />
        );
      case "unlocked":
        return (
          <UnlockedScreen
            viewRevision={vaultViewRevision}
            onLock={session.lock}
            onSignOut={session.signOut}
            onOpenSidePanel={panelAvailable ? () => openSidePanel() : undefined}
          />
        );
    }
  }
}

async function openRegistration(): Promise<void> {
  const url = `${webAppUrl}/register`;
  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    await chrome.tabs.create({ url, active: true });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
