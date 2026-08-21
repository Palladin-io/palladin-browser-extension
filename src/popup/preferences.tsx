import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { I18nProvider, type Locale } from "./i18n";
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_STORAGE_KEY,
  parseUiPreferences,
  resolveUiLocale,
  type LanguagePreference,
  type ThemePreference,
  type UiPreferences,
} from "@shared/config/ui-preferences";

export type PopupPreferences = UiPreferences;
export type { LanguagePreference, ThemePreference };

interface PreferencesContextValue extends PopupPreferences {
  readonly setLanguage: (language: LanguagePreference) => Promise<void>;
  readonly setTheme: (theme: ThemePreference) => Promise<void>;
}

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const DEFAULT_PREFERENCES: PopupPreferences = DEFAULT_UI_PREFERENCES;

const PreferencesContext = createContext<PreferencesContextValue>({
  ...DEFAULT_PREFERENCES,
  setLanguage: async () => undefined,
  setTheme: async () => undefined,
});

function browserStorage(): StorageArea | null {
  return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

export function parsePreferences(value: unknown): PopupPreferences {
  return parseUiPreferences(value);
}

export function resolveLocale(preference: LanguagePreference, systemLanguage: string): Locale {
  return resolveUiLocale(preference, systemLanguage);
}

export function PopupPreferencesProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [preferences, setPreferences] = useState<PopupPreferences>(DEFAULT_PREFERENCES);
  const [systemDark, setSystemDark] = useState(() =>
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const storage = browserStorage();
    if (storage === null) return;
    let active = true;
    void storage.get(UI_PREFERENCES_STORAGE_KEY).then((items) => {
      if (active) setPreferences(parsePreferences(items[UI_PREFERENCES_STORAGE_KEY]));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const persist = useCallback(async (next: PopupPreferences): Promise<void> => {
    setPreferences(next);
    await browserStorage()?.set({ [UI_PREFERENCES_STORAGE_KEY]: next });
  }, []);

  const value = useMemo<PreferencesContextValue>(() => ({
    ...preferences,
    setLanguage: (language) => persist({ ...preferences, language }),
    setTheme: (theme) => persist({ ...preferences, theme }),
  }), [persist, preferences]);

  const systemLanguage = typeof chrome !== "undefined" && chrome.i18n?.getUILanguage
    ? chrome.i18n.getUILanguage()
    : navigator.language;
  const locale = resolveLocale(preferences.language, systemLanguage);
  const resolvedTheme = preferences.theme === "system"
    ? (systemDark ? "dark" : "light")
    : preferences.theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.lang = locale;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [locale, resolvedTheme]);

  return (
    <PreferencesContext.Provider value={value}>
      <I18nProvider locale={locale}>{children}</I18nProvider>
    </PreferencesContext.Provider>
  );
}

export function usePopupPreferences(): PreferencesContextValue {
  return useContext(PreferencesContext);
}
