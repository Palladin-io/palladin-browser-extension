import { useState } from "react";

import { SettingsSection } from "../components/SettingsSection";
import type { ServerConfigClient } from "../config/client";
import { useI18n } from "../i18n";
import { AppearanceSettings } from "./AppearanceSettings";
import { ServerSettings } from "./ServerSettings";

export interface SettingsScreenProps {
  serverClient: ServerConfigClient;
  onServerChanged(): void;
}

export function SettingsScreen({
  serverClient,
  onServerChanged,
}: SettingsScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const [openSection, setOpenSection] = useState<string | null>(null);

  return (
    <div className="settings-screen">
      <SettingsSection
        id="appearance-settings"
        title={t("settings.appearance.title")}
        open={openSection === "appearance"}
        onToggle={() => toggle("appearance")}
      >
        <AppearanceSettings embedded />
      </SettingsSection>
      <SettingsSection
        id="server-settings"
        title={t("settings.server.title")}
        open={openSection === "server"}
        onToggle={() => toggle("server")}
      >
        <ServerSettings client={serverClient} onChanged={onServerChanged} embedded />
      </SettingsSection>
    </div>
  );

  function toggle(section: string): void {
    setOpenSection((current) => current === section ? null : section);
  }
}
