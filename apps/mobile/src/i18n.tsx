import { getLocales } from "expo-localization";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { normalizeLocale, translate, type Locale, type MessageKey } from "@shared/i18n";
import { readPrefs, writePrefs } from "./storage";

type Choice = "system" | Locale;

type I18n = {
  locale: Locale;
  choice: Choice;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  choose: (choice: Choice) => void;
};

const Ctx = createContext<I18n | null>(null);

/** 首次跟随系统语言（中文给中文，其余给英文），之后尊重用户在设置里的选择。语言只影响显示。 */
function systemLocale(): Locale {
  const tag = getLocales()[0]?.languageTag || "zh";
  return normalizeLocale(tag);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<Choice>("system");
  useEffect(() => {
    void readPrefs().then((prefs) => {
      if (prefs.language) setChoice(prefs.language);
    });
  }, []);
  const locale: Locale = choice === "system" ? systemLocale() : choice;
  const choose = useCallback((next: Choice) => {
    setChoice(next);
    void writePrefs({ language: next });
  }, []);
  const value = useMemo<I18n>(() => ({ locale, choice, choose, t: (key, vars) => translate(locale, key, vars) }), [choice, choose, locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const value = useContext(Ctx);
  if (!value) throw new Error("I18nProvider missing");
  return value;
}
