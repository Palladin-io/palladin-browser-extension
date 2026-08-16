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
import { createSessionClient, type SessionClient } from "./session/client";
import { useSession, type SessionPhase } from "./session/useSession";
import { SignInScreen } from "./screens/SignInScreen";
import { PairingScreen } from "./screens/PairingScreen";
import { TotpScreen } from "./screens/TotpScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { UnlockedScreen } from "./screens/UnlockedScreen";
import type { SessionStatus } from "../background/session/types";

export interface AppProps {
  /** Injected in tests; defaults to the real `chrome.runtime` channel. */
  client?: SessionClient;
  /** Injected in tests; defaults to the pairing command channel. */
  pairingClient?: AgentPairingClient;
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

export function App({ client, pairingClient }: AppProps): React.JSX.Element {
  const sessionClient = useMemo(() => client ?? createSessionClient(), [client]);
  const runtimeClient = useMemo(
    () => pairingClient ?? createAgentPairingClient(),
    [pairingClient],
  );
  const session = useSession(sessionClient);
  const [agentRuntimeOpen, setAgentRuntimeOpen] = useState(false);

  return (
    <main className="popup">
      <Header
        status={headerStatus(session.phase)}
        agentRuntimeOpen={agentRuntimeOpen}
        onToggleAgentRuntime={() => setAgentRuntimeOpen((open) => !open)}
      />
      {agentRuntimeOpen ? <PairingScreen client={runtimeClient} /> : renderPhase()}
    </main>
  );

  function renderPhase(): React.JSX.Element {
    switch (session.phase) {
      case "loading":
        return (
          <div className="centered">
            <Spinner />
            <span className="muted">Checking your session…</span>
          </div>
        );
      case "unavailable":
        return (
          <div className="centered">
            <span className="muted">Can't reach the Palladin background service.</span>
            <Button variant="subtle" onClick={session.retryInit}>
              Try again
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
