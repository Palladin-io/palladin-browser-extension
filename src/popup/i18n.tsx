import { createContext, useContext, type ReactNode } from "react";

import en from "./locales/en.json";
import pl from "./locales/pl.json";

export type Locale = "en" | "pl";
export type TranslationKey = keyof typeof en;
export type Translate = (key: TranslationKey, values?: Readonly<Record<string, string | number>>) => string;

const translations: Record<Locale, Record<TranslationKey, string>> = { en, pl };

export function translate(
  locale: Locale,
  key: TranslationKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const template = translations[locale][key] ?? translations.en[key];
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

const I18nContext = createContext<{ readonly locale: Locale; readonly t: Translate }>({
  locale: "en",
  t: (key, values) => translate("en", key, values),
});

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }): React.JSX.Element {
  return (
    <I18nContext.Provider value={{ locale, t: (key, values) => translate(locale, key, values) }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): { readonly locale: Locale; readonly t: Translate } {
  return useContext(I18nContext);
}

export const translationCatalogs = translations;
