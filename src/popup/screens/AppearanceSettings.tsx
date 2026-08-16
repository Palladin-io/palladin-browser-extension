import { useI18n } from "../i18n";
import { usePopupPreferences, type LanguagePreference, type ThemePreference } from "../preferences";

export function AppearanceSettings(): React.JSX.Element {
  const { t } = useI18n();
  const { language, theme, setLanguage, setTheme } = usePopupPreferences();

  return (
    <section className="appearance-settings">
      <h2 className="screen-title">{t("settings.appearance.title")}</h2>
      <p className="screen-subtitle">{t("settings.appearance.subtitle")}</p>
      <div className="appearance-grid">
        <label>
          <span className="field-label">{t("settings.language")}</span>
          <select
            className="field-input settings-select"
            value={language}
            onChange={(event) => void setLanguage(event.target.value as LanguagePreference)}
          >
            <option value="system">{t("settings.language.system")}</option>
            <option value="en">{t("settings.language.en")}</option>
            <option value="pl">{t("settings.language.pl")}</option>
          </select>
        </label>
        <label>
          <span className="field-label">{t("settings.theme")}</span>
          <select
            className="field-input settings-select"
            value={theme}
            onChange={(event) => void setTheme(event.target.value as ThemePreference)}
          >
            <option value="system">{t("settings.theme.system")}</option>
            <option value="light">{t("settings.theme.light")}</option>
            <option value="dark">{t("settings.theme.dark")}</option>
          </select>
        </label>
      </div>
    </section>
  );
}
