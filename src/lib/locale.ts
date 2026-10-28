import { cookies, headers } from "next/headers";
import { localeFromAcceptLanguage, normalizeLocale, type Locale } from "@shared/i18n";

export const LOCALE_COOKIE = "kkchat_lang";

/** 用户选过语言就用 Cookie；没选过跟随浏览器语言。 */
export async function requestLocale(): Promise<Locale> {
  const jar = await cookies();
  const chosen = jar.get(LOCALE_COOKIE)?.value;
  if (chosen) return normalizeLocale(chosen);
  return localeFromAcceptLanguage((await headers()).get("accept-language"));
}
