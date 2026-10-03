import { NextResponse } from "next/server";
import { loadConfig, sessionSecretReady } from "@/lib/config";
import { readCookie } from "@/lib/crypto";
import { safeReturnTo } from "@/lib/domain";
import { applyAuthCookies, freshCsrf } from "@/lib/http";
import { assertOidcStart, claimsToProjection, exchangeAuthorizationCode, verifyIdToken } from "@/lib/oidc";
import { getChatService } from "@/lib/app-service";
import { OIDC_COOKIE, createBrowserSession, openOidc } from "@/lib/session";

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
  const start = assertSafe(() =>
    assertOidcStart(openOidc(readCookie(request.headers.get("cookie"), OIDC_COOKIE), config.sessionSecret), state),
  );
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
    const response = NextResponse.redirect(new URL(safeReturnTo(start.returnTo), config.origin));
    applyAuthCookies(response, { sessionId: session.id, csrf: freshCsrf(), clearOidc: true }, config);
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
