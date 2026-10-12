import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { loadConfig, sessionSecretReady } from "@/lib/config";
import { readCookie } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { safeReturnTo } from "@/lib/domain";
import { applyAuthCookies, freshCsrf } from "@/lib/http";
import { assertOidcStart, claimsToProjection, exchangeAuthorizationCode, verifyIdToken } from "@/lib/oidc";
import { getChatService } from "@/lib/app-service";
import { DEVICE_COOKIE, OIDC_COOKIE, createBrowserSession, linkKkAccount, openOidc } from "@/lib/session";
import { holdCookieName } from "@/lib/tab-decision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const config = loadConfig();
  const url = new URL(request.url);
  const fail = (code: string) => NextResponse.redirect(new URL(`/?error=${encodeURIComponent(code)}`, config.origin));
  if (!sessionSecretReady(config) || !config.accountClientSecret) return fail("login-unconfigured");
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code) return fail("missing-code");
  const attempt = state
    ? await prisma.kkOidcAttempt.findUnique({
        where: { stateHash: createHash("sha256").update(state).digest("hex") },
      })
    : null;
  const sealed =
    attempt && !attempt.consumedAt && attempt.expiresAt.getTime() > Date.now()
      ? attempt.sealed
      : readCookie(request.headers.get("cookie"), OIDC_COOKIE);
  if (attempt && !attempt.consumedAt) {
    await prisma.kkOidcAttempt.update({ where: { id: attempt.id }, data: { consumedAt: new Date() } });
  }
  const start = assertSafe(() => assertOidcStart(openOidc(sealed, config.sessionSecret), state));
  if (!start) return fail("state");
  try {
    const tokens = await exchangeAuthorizationCode(config, { code, codeVerifier: start.verifier });
    const claims = await verifyIdToken(tokens.id_token, {
      issuer: config.accountIssuer,
      audience: config.accountClientId,
      nonce: start.nonce,
    });
    const projection = claimsToProjection(claims);
    await getChatService().upsertProjection(projection);
    const session = await createBrowserSession(projection.accountSub);
    const linked = await linkKkAccount({
      deviceToken: readCookie(request.headers.get("cookie"), DEVICE_COOKIE),
      sessionId: session.id,
      accountSub: projection.accountSub,
      contextId: attempt?.tabContextId,
    });
    const response = NextResponse.redirect(new URL(safeReturnTo(start.returnTo), config.origin));
    applyAuthCookies(
      response,
      { sessionId: linked.explicit ? undefined : session.id, csrf: freshCsrf(), clearOidc: true },
      config,
    );
    const base = { httpOnly: true, secure: config.cookieSecure, sameSite: "lax" as const, path: "/" };
    response.cookies.set(DEVICE_COOKIE, linked.deviceToken, { ...base, maxAge: 180 * 24 * 60 * 60 });
    response.cookies.set(holdCookieName(session.id), session.id, { ...base, maxAge: 30 * 24 * 60 * 60 });
    return response;
  } catch {
    return fail("callback");
  }
}

function assertSafe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
