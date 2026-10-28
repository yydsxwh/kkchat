import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceSession, PrismaClient } from "@prisma/client";
import { loadConfig, type KkchatConfig } from "./config";
import { randomToken, sha256Hex, tokensMatch } from "./crypto";
import { ChatError, isUserPublicId, type AccountClaims } from "./domain";
import { OidcError, verifyIdToken } from "./oidc";
import { upsertProjectionFromClaims } from "./projection";
import type { RealtimeBus } from "./realtime";

export const NATIVE_PLATFORMS = ["android", "ios"] as const;
export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export const NATIVE_TXN_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** 已完成的交换结果可恢复的时间：只覆盖「服务端成功但响应丢失」后的立即重试。 */
export const RESULT_RECOVERY_MS = 2 * 60 * 1000;
/** EXCHANGING 卡住超过这个时间，按授权码可能已被消费处理：作废，要求重新授权。 */
export const EXCHANGE_STALE_MS = 30 * 1000;
export const REFRESH_RETRY_WINDOW_MS = 60 * 1000;
/** 刷新时若来源账号会话超过这个时间没确认过，先同步确认一次。 */
export const SOURCE_CHECK_ON_REFRESH_MS = 2 * 60 * 1000;
/** 账号中心长时间不可达时，不能无限延长旧会话。超过这个时间没确认成功就拒绝刷新。 */
export const SOURCE_CHECK_HARD_LIMIT_MS = 6 * 60 * 60 * 1000;

const ACCESS_PREFIX = "kka1";
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export type NativeClientConfig = { clientId: string; redirectUri: string };

export function nativeClient(platform: NativePlatform, config: KkchatConfig = loadConfig()): NativeClientConfig {
  const redirectUri = process.env.KKCHAT_NATIVE_REDIRECT_URI?.trim() || `${config.origin}/native/auth/callback`;
  const clientId =
    platform === "android"
      ? process.env.KKCHAT_ANDROID_CLIENT_ID?.trim() || "kkchat-android"
      : process.env.KKCHAT_IOS_CLIENT_ID?.trim() || "kkchat-ios";
  return { clientId, redirectUri };
}

function secretKey(label: string, config: KkchatConfig = loadConfig()) {
  if (config.sessionSecret.length < 32) throw new ChatError(503, "登录还没配好");
  return createHmac("sha256", config.sessionSecret).update(label).digest();
}

export function seal(payload: unknown): string {
  const key = secretKey("kkchat-native-seal-v1");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(sealed: string): T | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const key = secretKey("kkchat-native-seal-v1");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 聊天 API 专用的短期凭证。不是 JWT，也不是账号中心令牌，别的产品拿到也用不了。 */
export function signAccessToken(sessionId: string, expiresAt: Date): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const payload = `${ACCESS_PREFIX}.${sessionId}.${exp}`;
  const sig = createHmac("sha256", secretKey("kkchat-native-access-v1")).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function parseAccessToken(token: string, now = Date.now()): { sessionId: string; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== ACCESS_PREFIX) return null;
  const [, sessionId, expText, sig] = parts;
  if (!/^[0-9a-f-]{36}$/.test(sessionId) || !/^\d{9,11}$/.test(expText)) return null;
  const expected = createHmac("sha256", secretKey("kkchat-native-access-v1"))
    .update(`${ACCESS_PREFIX}.${sessionId}.${expText}`)
    .digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const exp = Number(expText);
  if (exp * 1000 <= now) return null;
  return { sessionId, exp };
}

export type IssuedSession = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
  accountSub: string;
};

/** 可替换的账号中心交互，测试里注入假实现。 */
export type AccountOidcClient = {
  exchangeCode(input: { clientId: string; redirectUri: string; code: string; codeVerifier: string }): Promise<{ idToken: string }>;
  verifyIdToken(idToken: string, expected: { audience: string; nonce: string }): Promise<AccountClaims & { sid?: string; nonce?: string }>;
};

export const httpAccountOidc: AccountOidcClient = {
  async exchangeCode(input) {
    const config = loadConfig();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
    });
    let response: Response;
    try {
      response = await fetch(`${config.accountIssuer}/api/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new OidcError("network", "账号中心暂时不可达");
    }
    const json = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!response.ok || !json.id_token) throw new OidcError(json.error || "token_error", "账号中心没有返回身份令牌");
    return { idToken: json.id_token };
  },
  async verifyIdToken(idToken, expected) {
    const config = loadConfig();
    return verifyIdToken(idToken, { issuer: config.accountIssuer, audience: expected.audience, nonce: expected.nonce }) as Promise<
      AccountClaims & { sid?: string }
    >;
  },
};

export type SessionStatusClient = {
  /** 返回 sid → 是否仍有效。账号中心不可达时抛错，调用方不能把失败当成有效。 */
  check(sids: string[]): Promise<Map<string, boolean>>;
};

export const httpSessionStatus: SessionStatusClient = {
  async check(sids) {
    const config = loadConfig();
    if (!config.accountInternalToken) throw new Error("account_internal_token_missing");
    const response = await fetch(`${config.accountInternalBaseUrl}/api/internal/sessions/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.accountInternalToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ sids }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`account_session_status_${response.status}`);
    const payload = (await response.json()) as { sessions?: Record<string, { active?: boolean }> };
    const map = new Map<string, boolean>();
    for (const sid of sids) map.set(sid, payload.sessions?.[sid]?.active === true);
    return map;
  },
};

export class NativeAuthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly bus: RealtimeBus,
    private readonly oidc: AccountOidcClient = httpAccountOidc,
    private readonly sessionStatus: SessionStatusClient = httpSessionStatus,
  ) {}

  /**
   * 第 1 步：App 带着自己生成的 PKCE challenge 建立短期登录事务。
   * verifier 只在 App 里，服务端此时看不到。事务密钥只在这一次响应里出现。
   */
  async start(input: { platform: string; codeChallenge: string; deviceName?: string; prompt?: string | null }, now = new Date()) {
    const platform = parsePlatform(input.platform);
    if (!CODE_CHALLENGE_RE.test(input.codeChallenge || "")) throw new ChatError(400, "code_challenge 格式不对");
    const config = loadConfig();
    const client = nativeClient(platform, config);
    const transactionSecret = randomToken(32);
    const state = randomToken(24);
    const nonce = randomToken(24);
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + NATIVE_TXN_TTL_MS);
    await this.db.nativeLoginTransaction.create({
      data: {
        id,
        secretHash: sha256Hex(transactionSecret),
        platform,
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        state,
        nonce,
        codeChallenge: input.codeChallenge,
        deviceName: String(input.deviceName || "").slice(0, 80),
        expiresAt,
        createdAt: now,
      },
    });
    const authorize = new URL("/api/oauth/authorize", config.accountIssuer);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.clientId);
    authorize.searchParams.set("redirect_uri", client.redirectUri);
    authorize.searchParams.set("scope", "openid profile account.basic");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    authorize.searchParams.set("code_challenge", input.codeChallenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    if (input.prompt === "login") authorize.searchParams.set("prompt", "login");
    return {
      transactionId: id,
      transactionSecret,
      authorizeUrl: authorize.toString(),
      redirectUri: client.redirectUri,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * 第 3 步：App 交回授权码和 verifier。
   * 先用条件更新把事务从 PENDING 领到 EXCHANGING，再去账号中心换票（不持有数据库锁）。
   * 同一事务最多建立一个设备会话；完成后的短期重试只对同时持有事务密钥和 verifier 的请求返回原结果。
   */
  async exchange(
    input: { transactionId: string; transactionSecret: string; code: string; state: string; codeVerifier: string; appVersion?: string },
    now = new Date(),
  ): Promise<IssuedSession & { user: { accountSub: string; displayName: string; kkNumber: number | null; username: string | null; avatarUrl: string } }> {
    const txn = await this.db.nativeLoginTransaction.findUnique({ where: { id: String(input.transactionId || "") } });
    if (!txn || !tokensMatch(sha256Hex(String(input.transactionSecret || "")), txn.secretHash)) {
      throw new ChatError(400, "登录事务无效，请重新登录");
    }
    if (!input.state || input.state !== txn.state) throw new ChatError(400, "state 不一致，请重新登录");
    if (!CODE_VERIFIER_RE.test(input.codeVerifier || "")) throw new ChatError(400, "code_verifier 格式不对");
    const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
    if (challenge !== txn.codeChallenge) throw new ChatError(400, "PKCE 校验不通过");

    if (txn.status === "COMPLETED") return this.recover(txn, now);
    if (txn.status === "FAILED") throw restart(txn.failureCode || "failed");
    if (txn.expiresAt.getTime() <= now.getTime()) {
      await this.fail(txn.id, "expired");
      throw restart("expired");
    }
    if (txn.status === "EXCHANGING") {
      if (txn.exchangeStartedAt && now.getTime() - txn.exchangeStartedAt.getTime() > EXCHANGE_STALE_MS) {
        await this.fail(txn.id, "exchange_interrupted");
        throw restart("exchange_interrupted");
      }
      throw new ChatError(409, "登录正在完成，请稍候重试");
    }
    const claimed = await this.db.nativeLoginTransaction.updateMany({
      where: { id: txn.id, status: "PENDING" },
      data: { status: "EXCHANGING", exchangeStartedAt: now },
    });
    if (claimed.count !== 1) {
      const fresh = await this.db.nativeLoginTransaction.findUniqueOrThrow({ where: { id: txn.id } });
      if (fresh.status === "COMPLETED") return this.recover(fresh, now);
      throw new ChatError(409, "登录正在完成，请稍候重试");
    }

    let claims: AccountClaims & { sid?: string };
    try {
      const { idToken } = await this.oidc.exchangeCode({
        clientId: txn.clientId,
        redirectUri: txn.redirectUri,
        code: String(input.code || ""),
        codeVerifier: input.codeVerifier,
      });
      claims = await this.oidc.verifyIdToken(idToken, { audience: txn.clientId, nonce: txn.nonce });
    } catch (error) {
      const code = error instanceof OidcError ? error.code : "token_error";
      await this.fail(txn.id, code);
      throw restart(code);
    }
    if (!isUserPublicId(String(claims.sub || ""))) {
      await this.fail(txn.id, "invalid_sub");
      throw restart("invalid_sub");
    }
    const sid = typeof claims.sid === "string" ? claims.sid.trim() : "";
    if (!sid) {
      // 旧兼容登录没有可撤销的账号中心会话：不签发长期设备会话，要求带 prompt=login 重新认证。
      await this.fail(txn.id, "reauth_required");
      throw new ChatError(401, "reauth_required");
    }

    const projection = await upsertProjectionFromClaims(this.db, claims, now);
    const sessionId = randomUUID();
    const refreshToken = randomToken(32);
    const accessExpires = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
    const refreshExpires = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    const issued: IssuedSession = {
      accessToken: signAccessToken(sessionId, accessExpires),
      accessTokenExpiresAt: accessExpires.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpires.toISOString(),
      sessionId,
      accountSub: projection.accountSub,
    };
    const user = {
      accountSub: projection.accountSub,
      displayName: projection.displayName,
      kkNumber: projection.kkNumber,
      username: projection.username,
      avatarUrl: projection.avatarUrl,
    };
    const committed = await this.db.$transaction(async (tx) => {
      const moved = await tx.nativeLoginTransaction.updateMany({
        where: { id: txn.id, status: "EXCHANGING" },
        data: {
          status: "COMPLETED",
          deviceSessionId: sessionId,
          resultSealed: seal({ issued, user }),
          resultExpiresAt: new Date(now.getTime() + RESULT_RECOVERY_MS),
          completedAt: now,
        },
      });
      if (moved.count !== 1) return false;
      await tx.deviceSession.create({
        data: {
          id: sessionId,
          accountSub: projection.accountSub,
          platform: txn.platform,
          clientId: txn.clientId,
          accountSid: sid,
          deviceName: txn.deviceName,
          appVersion: String(input.appVersion || "").slice(0, 40),
          expiresAt: new Date(now.getTime() + DEVICE_SESSION_TTL_MS),
          sourceCheckedAt: now,
          lastSeenAt: now,
          createdAt: now,
        },
      });
      await tx.deviceRefreshToken.create({
        data: { id: randomUUID(), sessionId, tokenHash: sha256Hex(refreshToken), expiresAt: refreshExpires, createdAt: now },
      });
      return true;
    });
    if (!committed) throw restart("exchange_interrupted");
    return { ...issued, user };
  }

  private async recover(txn: { id: string; resultSealed: string | null; resultExpiresAt: Date | null; deviceSessionId: string | null }, now: Date) {
    if (!txn.resultSealed || !txn.resultExpiresAt || txn.resultExpiresAt.getTime() <= now.getTime()) {
      throw restart("transaction_completed");
    }
    const session = txn.deviceSessionId ? await this.db.deviceSession.findUnique({ where: { id: txn.deviceSessionId } }) : null;
    if (!session || session.revokedAt) throw restart("transaction_completed");
    const opened = unseal<{ issued: IssuedSession; user: { accountSub: string; displayName: string; kkNumber: number | null; username: string | null; avatarUrl: string } }>(
      txn.resultSealed,
    );
    if (!opened) throw restart("transaction_completed");
    return { ...opened.issued, user: opened.user };
  }

  private async fail(id: string, code: string) {
    await this.db.nativeLoginTransaction.updateMany({
      where: { id, status: { in: ["PENDING", "EXCHANGING"] } },
      data: { status: "FAILED", failureCode: code.slice(0, 60), resultSealed: null },
    });
  }

  /**
   * 刷新：单次使用。条件更新保证并发刷新只有一个成功。
   * 同一 requestId 的网络重试在 60 秒内拿回同一结果；其余重放视为泄露，只撤销这一台设备。
   */
  async refresh(input: { refreshToken: string; requestId: string }, now = new Date()): Promise<IssuedSession> {
    const requestId = String(input.requestId || "").slice(0, 80);
    if (!requestId) throw new ChatError(400, "缺少 requestId");
    const row = await this.db.deviceRefreshToken.findUnique({
      where: { tokenHash: sha256Hex(String(input.refreshToken || "")) },
      include: { session: true },
    });
    if (!row) throw new ChatError(401, "refresh_invalid");
    const session = row.session;
    if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) throw new ChatError(401, "session_revoked");
    if (row.usedAt) {
      if (row.usedRequestId === requestId && row.retryUntil && row.retryUntil.getTime() > now.getTime() && row.replacementSealed) {
        const replay = unseal<IssuedSession>(row.replacementSealed);
        if (replay) return replay;
      }
      await this.revokeSession(session.id, "refresh_reused", now);
      throw new ChatError(401, "refresh_reused");
    }
    if (row.expiresAt.getTime() <= now.getTime()) throw new ChatError(401, "refresh_expired");
    await this.ensureSourceFresh(session, now);

    const nextRefresh = randomToken(32);
    const accessExpires = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
    const refreshExpires = new Date(Math.min(now.getTime() + REFRESH_TOKEN_TTL_MS, session.expiresAt.getTime()));
    const issued: IssuedSession = {
      accessToken: signAccessToken(session.id, accessExpires),
      accessTokenExpiresAt: accessExpires.toISOString(),
      refreshToken: nextRefresh,
      refreshTokenExpiresAt: refreshExpires.toISOString(),
      sessionId: session.id,
      accountSub: session.accountSub,
    };
    const ok = await this.db.$transaction(async (tx) => {
      const claimed = await tx.deviceRefreshToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: {
          usedAt: now,
          usedRequestId: requestId,
          replacementSealed: seal(issued),
          retryUntil: new Date(now.getTime() + REFRESH_RETRY_WINDOW_MS),
        },
      });
      if (claimed.count !== 1) return false;
      await tx.deviceRefreshToken.create({
        data: { id: randomUUID(), sessionId: session.id, tokenHash: sha256Hex(nextRefresh), expiresAt: refreshExpires, createdAt: now },
      });
      await tx.deviceSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
      return true;
    });
    if (!ok) {
      // 并发刷新的另一边先赢了：同一 requestId 的合并请求可以拿到它的结果。
      const fresh = await this.db.deviceRefreshToken.findUniqueOrThrow({ where: { id: row.id } });
      if (fresh.usedRequestId === requestId && fresh.replacementSealed) {
        const replay = unseal<IssuedSession>(fresh.replacementSealed);
        if (replay) return replay;
      }
      await this.revokeSession(session.id, "refresh_reused", now);
      throw new ChatError(401, "refresh_reused");
    }
    return issued;
  }

  /** 账号中心是来源。超过上限没确认成功，就不再延长会话。 */
  private async ensureSourceFresh(session: DeviceSession, now: Date) {
    const age = now.getTime() - session.sourceCheckedAt.getTime();
    if (age < SOURCE_CHECK_ON_REFRESH_MS) return;
    try {
      const status = await this.sessionStatus.check([session.accountSid]);
      if (status.get(session.accountSid) !== true) {
        await this.revokeSession(session.id, "account_session_revoked", now);
        throw new ChatError(401, "session_revoked");
      }
      await this.db.deviceSession.update({ where: { id: session.id }, data: { sourceCheckedAt: now } });
    } catch (error) {
      if (error instanceof ChatError) throw error;
      if (age > SOURCE_CHECK_HARD_LIMIT_MS) throw new ChatError(503, "暂时无法确认账号状态，请稍后重试");
    }
  }

  async verifyAccess(token: string, now = new Date()): Promise<DeviceSession | null> {
    const parsed = parseAccessToken(token, now.getTime());
    if (!parsed) return null;
    const session = await this.db.deviceSession.findUnique({ where: { id: parsed.sessionId } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return null;
    return session;
  }

  async revokeSession(sessionId: string, reason: string, now = new Date()) {
    const session = await this.db.deviceSession.findUnique({ where: { id: sessionId } });
    if (!session) return false;
    const updated = await this.db.deviceSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason.slice(0, 60) },
    });
    await this.db.pushDevice.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } });
    await this.db.deviceRefreshToken.updateMany({
      where: { sessionId, usedAt: null },
      data: { usedAt: now, usedRequestId: `revoked:${reason}`.slice(0, 80) },
    });
    this.bus.disconnect(session.accountSub, sessionId);
    return updated.count === 1;
  }

  async listSessions(accountSub: string) {
    const rows = await this.db.deviceSession.findMany({
      where: { accountSub, revokedAt: null },
      orderBy: { lastSeenAt: "desc" },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      deviceName: row.deviceName,
      appVersion: row.appVersion,
      lastSeenAt: row.lastSeenAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async registerPush(session: DeviceSession, input: { provider: string; token: string; environment?: string }, now = new Date()) {
    const provider = input.provider === "APNS" || input.provider === "FCM" ? input.provider : null;
    if (!provider) throw new ChatError(400, "不支持的推送通道");
    const token = String(input.token || "").trim();
    if (!/^[A-Za-z0-9:_\-.]{16,4096}$/.test(token)) throw new ChatError(400, "推送令牌格式不对");
    const environment = input.environment === "sandbox" ? "sandbox" : "production";
    // 同一个系统令牌只能属于当前设备会话：切号后旧账号不再收到推送。
    await this.db.pushDevice.upsert({
      where: { provider_token: { provider, token } },
      create: { id: randomUUID(), sessionId: session.id, accountSub: session.accountSub, provider, token, environment, createdAt: now },
      update: { sessionId: session.id, accountSub: session.accountSub, environment, revokedAt: null },
    });
    await this.db.pushDevice.updateMany({
      where: { sessionId: session.id, revokedAt: null, NOT: { provider, token } },
      data: { revokedAt: now },
    });
    return { provider, environment };
  }
}

function parsePlatform(value: string): NativePlatform {
  if ((NATIVE_PLATFORMS as readonly string[]).includes(value)) return value as NativePlatform;
  throw new ChatError(400, "不支持的平台");
}

function restart(code: string) {
  return new ChatError(401, `restart_auth:${code}`.slice(0, 80));
}
