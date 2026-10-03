/**
 * 运行参数集中在这里。域名、端口、密钥都不写进业务分支。
 * 读取时不打印任何密钥。
 */

export type KkchatConfig = {
  origin: string;
  databaseUrl: string;
  sessionSecret: string;
  accountIssuer: string;
  accountClientId: string;
  accountClientSecret: string;
  accountRedirectUri: string;
  accountScopes: string;
  accountInternalBaseUrl: string;
  accountInternalToken: string;
  serviceToken: string;
  serviceTokens: Record<string, string>;
  cookieSecure: boolean;
  mainSiteUrl: string;
  platformBaseUrl: string;
  platformServiceToken: string;
  redisUrl: string;
};

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KkchatConfig {
  const origin = trimSlash(env.KKCHAT_ORIGIN?.trim() || "http://127.0.0.1:3210");
  const issuer = trimSlash(env.ACCOUNT_ISSUER?.trim() || "https://account.yydsxwh.com");
  const tokens = parseServiceTokens(env.KKCHAT_SERVICE_TOKENS);
  return {
    origin,
    databaseUrl: env.DATABASE_URL?.trim() || "",
    sessionSecret: env.KKCHAT_SESSION_SECRET?.trim() || "",
    accountIssuer: issuer,
    accountClientId: env.ACCOUNT_CLIENT_ID?.trim() || "kkchat",
    accountClientSecret: env.ACCOUNT_CLIENT_SECRET?.trim() || "",
    accountRedirectUri: env.ACCOUNT_REDIRECT_URI?.trim() || `${origin}/api/auth/callback`,
    accountScopes: env.ACCOUNT_SCOPES?.trim() || "openid profile account.basic offline_access",
    accountInternalBaseUrl: trimSlash(env.ACCOUNT_INTERNAL_BASE_URL?.trim() || issuer),
    accountInternalToken: env.ACCOUNT_INTERNAL_TOKEN?.trim() || "",
    serviceToken: env.KKCHAT_SERVICE_TOKEN?.trim() || "",
    serviceTokens: tokens,
    cookieSecure: env.KKCHAT_COOKIE_SECURE === "true" || origin.startsWith("https://"),
    mainSiteUrl: trimSlash(env.MAIN_SITE_URL?.trim() || "https://www.yydsxwh.com"),
    platformBaseUrl: trimSlash(env.PLATFORM_BASE_URL?.trim() || ""),
    platformServiceToken: env.PLATFORM_SERVICE_TOKEN?.trim() || "",
    redisUrl: env.KKCHAT_REDIS_URL?.trim() || "",
  };
}

function parseServiceTokens(raw: string | undefined): Record<string, string> {
  const text = raw?.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) out[key.toLowerCase()] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function sessionSecretReady(config: KkchatConfig): boolean {
  return config.sessionSecret.length >= 32;
}

/** 已登记、允许作为消息来源的产品。与 shared CONFIG_PRODUCT_IDS 对齐，并包含 kkchat 自己。 */
export const SOURCE_PRODUCTS = [
  "main",
  "account",
  "academic",
  "course",
  "rishi",
  "softwarelist",
  "forum",
  "meetup",
  "personalwebsite",
  "mathcode",
  "valorant",
  "kkchat",
] as const;

export type SourceProduct = (typeof SOURCE_PRODUCTS)[number];

export function isSourceProduct(value: string): value is SourceProduct {
  return (SOURCE_PRODUCTS as readonly string[]).includes(value);
}
