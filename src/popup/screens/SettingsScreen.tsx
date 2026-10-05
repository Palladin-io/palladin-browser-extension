import { useState } from "react";

import { SettingsSection } from "../components/SettingsSection";
import { useI18n } from "../i18n";
import { AppearanceSettings } from "./AppearanceSettings";
import { ServerSettings } from "./ServerSettings";
import { CaptureSettings } from "./CaptureSettings";
import { SharedUnlockSettings } from './SharedUnlockSettings';

export interface SettingsScreenProps {
  split?: boolean;
  onServerChanged(): void;
}

export function SettingsScreen({
  split = false,
  onServerChanged,
}: SettingsScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const [openSection, setOpenSection] = useState<string | null>(split ? "appearance" : null);

  const sections = [
    ['appearance', 'settings.appearance.title'],
    ['server', 'settings.server.title'],
    ['capture', 'captureSettings.title'],
    ['shared-unlock', 'sharedUnlockSettings.title'],
  ] as const;
  if (split) return (
    <div className="settings-split">
      <nav className="settings-list" aria-label={t('common.settings')}>
        {sections.map(([id, title]) => <button key={id} type="button" aria-current={openSection === id ? 'page' : undefined}
          onClick={() => setOpenSection(id)}>{t(title)}</button>)}
      </nav>
      <section className="settings-detail" aria-label={t(sections.find(([id]) => id === openSection)![1])}>
        {openSection !== 'shared-unlock' ? <h2>{t(sections.find(([id]) => id === openSection)![1])}</h2> : null}
        {openSection === 'appearance' ? <AppearanceSettings embedded /> :
          openSection === 'server' ? <ServerSettings onChanged={onServerChanged} embedded /> :
          openSection === 'capture' ? <CaptureSettings /> : <SharedUnlockSettings />}
      </section>
    </div>
  );

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
        <ServerSettings onChanged={onServerChanged} embedded />
      </SettingsSection>
      <SettingsSection id="capture-settings" title={t("captureSettings.title")}
        open={openSection === "capture"} onToggle={() => toggle("capture")}>
        <CaptureSettings />
      </SettingsSection>
      <SharedUnlockSettings />
    </div>
  );

  function toggle(section: string): void {
    setOpenSection((current) => current === section ? null : section);
  }
}
