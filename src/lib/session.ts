import { createHash, randomBytes } from "node:crypto";
import { randomToken, readCookie, signPayload, verifyPayload } from "./crypto";
import { loadConfig, sessionSecretReady, type KkchatConfig } from "./config";
import { prisma } from "./db";
import type { OidcStart } from "./oidc";
import { DEVICE_COOKIE, holdCookieName, isTabContextId, resolveAccess, type BrokerState } from "./tab-decision";

export { DEVICE_COOKIE };

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
  const tabbed = await readTabSession(request, now);
  if (tabbed === "ambiguous") return null;
  if (tabbed) return tabbed;
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

function deviceHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function readTabSession(request: Request, now: Date): Promise<SessionRecord | null | "ambiguous"> {
  const token = readCookie(request.headers.get("cookie"), DEVICE_COOKIE);
  if (!token) return null;
  const device = await prisma.kkDevice.findUnique({
    where: { tokenHash: deviceHash(token) },
    include: { accounts: { where: { revokedAt: null } }, tabs: { where: { revokedAt: null } } },
  });
  if (!device || device.revokedAt) return null;
  const state: BrokerState = {
    explicitPick: device.explicitPick,
    defaultSessionId: null,
    accounts: device.accounts.map((account) => ({
      sessionId: account.sessionId,
      userId: account.accountSub,
      active: true,
      grantedRoles: [],
      defaultRole: null,
      pendingReview: false,
      authTimeSec: null,
      display: {
        name: account.accountSub,
        kkNumber: null,
        emailMasked: "",
        phoneMasked: "",
        avatarUrl: "",
        subHint: account.accountSub,
      },
    })),
    tabs: device.tabs.map((tab) => ({
      contextId: tab.id,
      sessionId: tab.sessionId || null,
      activeRole: "",
      revoked: false,
    })),
  };
  const queryTab = new URL(request.url).searchParams.get("tab");
  const decision = resolveAccess(state, {
    tabHeader: request.headers.get("x-yyds-tab") || queryTab,
  });
  if (decision.kind === "ambiguous") return "ambiguous";
  if (decision.kind !== "ready") return null;
  const row = await prisma.browserSession.findUnique({ where: { id: decision.account.sessionId } });
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.accountSub !== decision.account.userId) return null;
  return { id: row.id, accountSub: row.accountSub, expiresAt: row.expiresAt };
}

export async function linkKkAccount(input: { deviceToken?: string; sessionId: string; accountSub: string; contextId?: string | null }) {
  let token = input.deviceToken || "";
  let device = token
    ? await prisma.kkDevice.findUnique({ where: { tokenHash: deviceHash(token) } })
    : null;
  if (!device || device.revokedAt) {
    token = randomBytes(32).toString("base64url");
    device = await prisma.kkDevice.create({ data: { tokenHash: deviceHash(token) } });
  }
  await prisma.kkDeviceAccount.upsert({
    where: { deviceId_accountSub: { deviceId: device.id, accountSub: input.accountSub } },
    create: { deviceId: device.id, sessionId: input.sessionId, accountSub: input.accountSub },
    update: { sessionId: input.sessionId, revokedAt: null },
  });
  const count = await prisma.kkDeviceAccount.count({ where: { deviceId: device.id, revokedAt: null } });
  if (count > 1) await prisma.kkDevice.update({ where: { id: device.id }, data: { explicitPick: true } });
  if (isTabContextId(input.contextId)) {
    await prisma.kkTab.upsert({
      where: { id: input.contextId },
      create: { id: input.contextId, deviceId: device.id, sessionId: input.sessionId },
      update: { deviceId: device.id, sessionId: input.sessionId, revokedAt: null },
    });
  }
  return { deviceToken: token, explicit: count > 1, holdName: holdCookieName(input.sessionId) };
}
