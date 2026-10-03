import { randomToken, readCookie, signPayload, verifyPayload } from "./crypto";
import { loadConfig, sessionSecretReady, type KkchatConfig } from "./config";
import { prisma } from "./db";
import type { OidcStart } from "./oidc";

export const SESSION_COOKIE = "kkchat_session";
export const OIDC_COOKIE = "kkchat_oidc";
export const CSRF_COOKIE = "kkchat_csrf";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionRecord = {
  id: string;
  accountSub: string;
  expiresAt: Date;
};

export function cookieBase(config: KkchatConfig) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
    path: "/",
  };
}

export async function createBrowserSession(accountSub: string, now = new Date()): Promise<SessionRecord> {
  const id = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await prisma.browserSession.create({
    data: { id, accountSub, expiresAt },
  });
  return { id, accountSub, expiresAt };
}

export async function readSession(request: Request, now = new Date()): Promise<SessionRecord | null> {
  const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!id) return null;
  const row = await prisma.browserSession.findUnique({ where: { id } });
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  return { id: row.id, accountSub: row.accountSub, expiresAt: row.expiresAt };
}

export async function revokeSession(request: Request) {
  const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!id) return;
  await prisma.browserSession.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function sealOidc(start: OidcStart, secret: string) {
  return signPayload(start, secret);
}

export function openOidc(token: string, secret: string): OidcStart | null {
  return verifyPayload<OidcStart>(token, secret);
}

export function requireSecret(config = loadConfig()): KkchatConfig {
  if (!sessionSecretReady(config)) {
    throw new Error("session_secret_missing");
  }
  return config;
}

export function newCsrfToken() {
  return randomToken(24);
}
