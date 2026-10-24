import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { newClientId } from "@shared/client";
import type { NativeSession } from "@shared/types";
import { API_BASE_URL, APP_CALLBACK, APP_VERSION, PLATFORM } from "./config";
import { parseAuthCallback } from "./links";
import { secureDelete, secureGet, secureSet, sessionKey } from "./storage";

/**
 * App 登录：Authorization Code + PKCE（S256），在系统浏览器 / ASWebAuthenticationSession 里完成账号中心登录，
 * 不在 App 内嵌网页收集密码。verifier 只在本机，账号中心的令牌不进 App；
 * App 只拿到 KKChat 自己签发的短期聊天凭证和可撤销的设备刷新凭证，存在系统安全存储里。
 */

export type StoredSession = NativeSession & {
  /** 刷新请求已发出但还没确认保存时记住的 requestId：重启后用同一个 ID 重试，服务端返回同一结果。 */
  pendingRefreshId?: string;
};

export type AccountSummary = { accountSub: string; displayName: string; kkNumber: number | null; avatarUrl: string };

const ACCOUNTS_KEY = "kkchat.accounts";
const CURRENT_KEY = "kkchat.current";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: "cancelled" | "network" | "reauth" | "failed" | "expired",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function base64Url(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = bytes[index] << 16;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63];
  }
  return out;
}

export async function createPkce() {
  const verifier = base64Url(Crypto.getRandomBytes(48));
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const challenge = digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T & { error?: string; code?: string } }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("network", "network");
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { status: response.status, data };
}

/** 从回调地址里取授权结果。只认固定的 kkchat://auth/callback 或本站 https 回调。 */
export function parseCallback(url: string) {
  return parseAuthCallback(url, API_BASE_URL);
}

/**
 * 打开系统授权会话。Android 上若 App Links 直接把 https 回调交给了 App，就从 Linking 事件里取结果并收起浏览器。
 */
async function authorizeInBrowser(authorizeUrl: string, ephemeral: boolean): Promise<string> {
  let linkSubscription: { remove(): void } | null = null;
  const linkResult = new Promise<string>((resolve) => {
    linkSubscription = Linking.addEventListener("url", ({ url }) => {
      if (parseCallback(url)) {
        resolve(url);
        WebBrowser.dismissAuthSession();
      }
    });
  });
  try {
    const browser = WebBrowser.openAuthSessionAsync(authorizeUrl, APP_CALLBACK, {
      preferEphemeralSession: ephemeral,
      showInRecents: true,
    }).then((result) => {
      if (result.type === "success") return result.url;
      return "";
    });
    const url = await Promise.race([browser, linkResult]);
    if (!url) {
      // 浏览器被关掉，但 Linking 可能刚好送到了回调：稍等一下再判定取消。
      const late = await Promise.race([linkResult, new Promise<string>((resolve) => setTimeout(() => resolve(""), 600))]);
      if (!late) throw new AuthError("cancelled", "cancelled");
      return late;
    }
    return url;
  } finally {
    (linkSubscription as { remove(): void } | null)?.remove();
  }
}

export async function signIn(options: { prompt?: "login"; locale: "zh" | "en" }): Promise<{ session: StoredSession; account: AccountSummary }> {
  const pkce = await createPkce();
  const deviceName = [Device.manufacturer, Device.modelName].filter(Boolean).join(" ").slice(0, 80) || PLATFORM;
  const start = await post<{ transactionId: string; transactionSecret: string; authorizeUrl: string }>("/api/native/v1/auth/start", {
    platform: PLATFORM,
    codeChallenge: pkce.challenge,
    deviceName,
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
  if (start.status !== 200) throw new AuthError(start.data.error || "failed", "failed");
  const authorize = new URL(start.data.authorizeUrl);
  authorize.searchParams.set("ui_locales", options.locale === "en" ? "en" : "zh-CN");
  const callbackUrl = await authorizeInBrowser(authorize.toString(), options.prompt === "login");
  const callback = parseCallback(callbackUrl);
  if (!callback || callback.error || !callback.code || !callback.state) {
    throw new AuthError(callback?.error || "failed", callback?.error === "access_denied" ? "cancelled" : "failed");
  }
  const body = {
    transactionId: start.data.transactionId,
    transactionSecret: start.data.transactionSecret,
    code: callback.code,
    state: callback.state,
    codeVerifier: pkce.verifier,
    appVersion: APP_VERSION,
  };
  // 同一事务的合法重试：网络失败或服务端正在完成时，用完全相同的参数再试，服务端不会重复换票。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let result: Awaited<ReturnType<typeof post<NativeSession & { user: AccountSummary }>>>;
    try {
      result = await post<NativeSession & { user: AccountSummary }>("/api/native/v1/auth/exchange", body);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      continue;
    }
    if (result.status === 200) {
      const { user, ...session } = result.data;
      const account: AccountSummary = {
        accountSub: user.accountSub,
        displayName: user.displayName,
        kkNumber: user.kkNumber,
        avatarUrl: user.avatarUrl,
      };
      await saveSession(account.accountSub, session);
      await rememberAccount(account);
      await secureSet(CURRENT_KEY, account.accountSub);
      return { session, account };
    }
    if (result.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      continue;
    }
    if (result.data.code === "reauth_required") {
      if (options.prompt === "login") throw new AuthError("reauth", "reauth");
      return signIn({ ...options, prompt: "login" });
    }
    throw new AuthError(result.data.error || "failed", "failed");
  }
  throw new AuthError("failed", "failed");
}

export async function saveSession(sub: string, session: StoredSession) {
  await secureSet(sessionKey(sub), session);
}

export async function loadSession(sub: string) {
  return secureGet<StoredSession>(sessionKey(sub));
}

export async function listAccounts(): Promise<AccountSummary[]> {
  return (await secureGet<AccountSummary[]>(ACCOUNTS_KEY)) || [];
}

async function rememberAccount(account: AccountSummary) {
  const accounts = (await listAccounts()).filter((item) => item.accountSub !== account.accountSub);
  await secureSet(ACCOUNTS_KEY, [account, ...accounts].slice(0, 5));
}

export async function updateAccountSummary(account: AccountSummary) {
  const accounts = await listAccounts();
  if (!accounts.some((item) => item.accountSub === account.accountSub)) return;
  await secureSet(ACCOUNTS_KEY, accounts.map((item) => (item.accountSub === account.accountSub ? account : item)));
}

export async function currentAccountSub(): Promise<string | null> {
  return secureGet<string>(CURRENT_KEY);
}

export async function setCurrentAccount(sub: string | null) {
  if (sub) await secureSet(CURRENT_KEY, sub);
  else await secureDelete(CURRENT_KEY);
}

/** 退出：先通知服务端撤销设备会话（失败也继续），再删本机凭证。 */
export async function signOut(sub: string) {
  const session = await loadSession(sub);
  if (session) {
    await post("/api/native/v1/auth/logout", {}, { authorization: `Bearer ${session.accessToken}` }).catch(() => undefined);
  }
  await secureDelete(sessionKey(sub));
  const accounts = (await listAccounts()).filter((item) => item.accountSub !== sub);
  await secureSet(ACCOUNTS_KEY, accounts);
  if ((await currentAccountSub()) === sub) await setCurrentAccount(accounts[0]?.accountSub ?? null);
}

const inflight = new Map<string, Promise<StoredSession>>();

/**
 * 单飞刷新：同一账号同时只有一个刷新请求，其他调用等它。
 * requestId 先写进安全存储再发请求：响应丢失或进程被杀后，用同一个 requestId 重试拿回同一结果，
 * 不会因为正常重试被当成重放而撤销设备。
 */
export function refreshSession(sub: string): Promise<StoredSession> {
  const existing = inflight.get(sub);
  if (existing) return existing;
  const task = (async () => {
    const session = await loadSession(sub);
    if (!session) throw new AuthError("expired", "expired");
    const requestId = session.pendingRefreshId || newClientId();
    if (!session.pendingRefreshId) await saveSession(sub, { ...session, pendingRefreshId: requestId });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let result: Awaited<ReturnType<typeof post<NativeSession>>>;
      try {
        result = await post<NativeSession>("/api/native/v1/auth/refresh", { refreshToken: session.refreshToken, requestId });
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (result.status === 200) {
        const next: StoredSession = { ...result.data };
        await saveSession(sub, next);
        return next;
      }
      if (result.status === 401) {
        await secureDelete(sessionKey(sub));
        throw new AuthError(result.data.code || "expired", "expired");
      }
      if (result.status >= 500 || result.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      throw new AuthError(result.data.error || "failed", "failed");
    }
    throw new AuthError("network", "network");
  })().finally(() => inflight.delete(sub));
  inflight.set(sub, task);
  return task;
}

/** 返回可用的短期聊天凭证，快过期时先刷新。 */
export async function accessToken(sub: string): Promise<string> {
  const session = await loadSession(sub);
  if (!session) throw new AuthError("expired", "expired");
  if (session.pendingRefreshId || Date.parse(session.accessTokenExpiresAt) - Date.now() < 60_000) {
    return (await refreshSession(sub)).accessToken;
  }
  return session.accessToken;
}
