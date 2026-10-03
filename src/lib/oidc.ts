import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createPkcePair, randomToken } from "./crypto";
import type { KkchatConfig } from "./config";
import { projectionFromClaims, type AccountClaims } from "./domain";

export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export type OidcStart = {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string) {
  const url = `${issuer}/.well-known/jwks.json`;
  const cached = jwksCache.get(url);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(url), {
    timeoutDuration: 2500,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  jwksCache.set(url, jwks);
  return jwks;
}

export function startOidc(returnTo: string, now = Date.now()): { start: OidcStart; challenge: string } {
  const { verifier, challenge } = createPkcePair();
  return {
    start: {
      state: randomToken(16),
      nonce: randomToken(16),
      verifier,
      returnTo,
      exp: now + 10 * 60_000,
    },
    challenge,
  };
}

export function buildAuthorizeUrl(config: KkchatConfig, start: OidcStart, challenge: string): string {
  const authorize = new URL("/api/oauth/authorize", config.accountIssuer);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", config.accountClientId);
  authorize.searchParams.set("redirect_uri", config.accountRedirectUri);
  authorize.searchParams.set("scope", config.accountScopes);
  authorize.searchParams.set("state", start.state);
  authorize.searchParams.set("nonce", start.nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return authorize.toString();
}

export function assertOidcStart(start: OidcStart | null, state: string, now = Date.now()): OidcStart {
  if (!start) throw new OidcError("invalid_state", "登录状态已失效");
  if (start.exp < now) throw new OidcError("invalid_state", "登录状态已过期");
  if (!state || start.state !== state) throw new OidcError("invalid_state", "state 不一致");
  if (!start.nonce || !start.verifier) throw new OidcError("invalid_state", "缺少 PKCE 或 nonce");
  return start;
}

export async function exchangeAuthorizationCode(
  config: KkchatConfig,
  input: { code: string; codeVerifier: string },
): Promise<{ id_token: string; access_token?: string; refresh_token?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.accountRedirectUri,
    code_verifier: input.codeVerifier,
    client_id: config.accountClientId,
    client_secret: config.accountClientSecret,
  });
  const response = await fetch(`${config.accountIssuer}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await response.json().catch(() => ({}))) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.id_token) {
    throw new OidcError(json.error || "token_error", "账号中心没有返回身份令牌");
  }
  return { id_token: json.id_token, access_token: json.access_token, refresh_token: json.refresh_token };
}

export async function verifyIdToken(
  idToken: string,
  expected: { issuer: string; audience: string; nonce?: string },
  getKey: Parameters<typeof jwtVerify>[1] = jwksFor(expected.issuer),
): Promise<AccountClaims> {
  if (!idToken) throw new OidcError("invalid_id_token", "缺少 id_token");
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(idToken, getKey, {
      issuer: expected.issuer,
      audience: expected.audience,
      algorithms: ["RS256"],
    });
    payload = verified.payload;
  } catch (error) {
    const text = error instanceof Error ? error.message : "invalid";
    if (/issuer/i.test(text)) throw new OidcError("invalid_issuer", "签发方不匹配");
    if (/audience/i.test(text)) throw new OidcError("invalid_audience", "受众不匹配");
    throw new OidcError("invalid_id_token", "身份令牌无效");
  }
  if (expected.nonce && payload.nonce !== expected.nonce) {
    throw new OidcError("invalid_nonce", "nonce 不一致");
  }
  return payload as AccountClaims;
}

export function claimsToProjection(claims: AccountClaims, now = new Date()) {
  return projectionFromClaims(claims, now);
}
