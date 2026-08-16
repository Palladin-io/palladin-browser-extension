/**
 * Popup root: a small state machine over the worker's session status. It shows
 * exactly one of sign-in / TOTP / unlock / unlocked, driven by the phase from
 * {@link useSession}. The session client is injectable so the whole flow is
 * testable against a fake command channel, with no live `chrome`.
 */

import { useMemo, useState } from "react";

import { createAgentPairingClient, type AgentPairingClient } from "./agent/client";
import { Button } from "./components/Button";
import { Header } from "./components/Header";
import { Spinner } from "./components/Spinner";
import { createServerConfigClient, type ServerConfigClient } from "./config/client";
import { useI18n } from "./i18n";
import { createSessionClient, type SessionClient } from "./session/client";
import { useSession, type SessionPhase } from "./session/useSession";
import { SignInScreen } from "./screens/SignInScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TotpScreen } from "./screens/TotpScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { UnlockedScreen } from "./screens/UnlockedScreen";
import type { SessionStatus } from "../background/session/types";

export interface AppProps {
  /** Injected in tests; defaults to the real `chrome.runtime` channel. */
  client?: SessionClient;
  /** Injected in tests; defaults to the pairing command channel. */
  pairingClient?: AgentPairingClient;
  /** Injected in tests; defaults to the server configuration channel. */
  serverConfigClient?: ServerConfigClient;
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

export function App({ client, pairingClient, serverConfigClient }: AppProps): React.JSX.Element {
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
  const session = useSession(sessionClient);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <main className="popup">
      <Header
        status={headerStatus(session.phase)}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
      />
      {settingsOpen ? (
        <SettingsScreen
          serverClient={serverClient}
          pairingClient={runtimeClient}
          onServerChanged={session.retryInit}
        />
      ) : renderPhase()}
    </main>
  );

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
        return <SignInScreen onSignIn={session.signIn} />;
      case "totp":
        return <TotpScreen onSubmitTotp={session.submitTotp} onBack={session.cancelTotp} />;
      case "locked":
        return (
          <UnlockScreen
            onUnlock={session.unlock}
            biometricAvailable={session.capabilities?.runtimeUnlock ?? false}
          />
        );
      case "unlocked":
        return <UnlockedScreen onLock={session.lock} onSignOut={session.signOut} />;
    }
  }
}
