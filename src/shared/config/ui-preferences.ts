export type UiLocale = "en" | "pl";
export type LanguagePreference = "system" | UiLocale;
export type ThemePreference = "system" | "light" | "dark";

export interface UiPreferences {
  readonly language: LanguagePreference;
  readonly theme: ThemePreference;
}

export const UI_PREFERENCES_STORAGE_KEY = "palladin.ui.preferences";
export const DEFAULT_UI_PREFERENCES: UiPreferences = { language: "system", theme: "system" };

export function parseUiPreferences(value: unknown): UiPreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_UI_PREFERENCES;
  const record = value as Record<string, unknown>;
  const language = record["language"];
  const theme = record["theme"];
  return {
    language: language === "en" || language === "pl" || language === "system"
      ? language
      : "system",
    theme: theme === "light" || theme === "dark" || theme === "system"
      ? theme
      : "system",
  };
}

export function resolveUiLocale(preference: LanguagePreference, systemLanguage: string): UiLocale {
  if (preference !== "system") return preference;
  return systemLanguage.toLowerCase().startsWith("pl") ? "pl" : "en";
}
