import type { AgentPairingClient } from "../agent/client";
import type { ServerConfigClient } from "../config/client";
import { PairingScreen } from "./PairingScreen";
import { ServerSettings } from "./ServerSettings";

export interface SettingsScreenProps {
  serverClient: ServerConfigClient;
  pairingClient: AgentPairingClient;
  onServerChanged(): void;
}

export function SettingsScreen({
  serverClient,
  pairingClient,
  onServerChanged,
}: SettingsScreenProps): React.JSX.Element {
  return (
    <div className="settings-screen">
      <ServerSettings client={serverClient} onChanged={onServerChanged} />
      <div className="settings-divider" />
      <PairingScreen client={pairingClient} />
    </div>
  );
}
