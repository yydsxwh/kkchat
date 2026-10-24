"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { translate, type Locale, type MessageKey } from "@shared/i18n";

type I18n = {
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => void;
};

const Context = createContext<I18n>({
  locale: "zh",
  t: (key, vars) => translate("zh", key, vars),
  setLocale: () => undefined,
});

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.cookie = `kkchat_lang=${next}; path=/; max-age=${365 * 24 * 60 * 60}; samesite=lax`;
    document.documentElement.lang = next === "zh" ? "zh-Hans" : "en";
  }, []);
  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n() {
  return useContext(Context);
}
