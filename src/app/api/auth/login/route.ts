import { NextResponse } from "next/server";
import { loadConfig, sessionSecretReady } from "@/lib/config";
import { applyAuthCookies } from "@/lib/http";
import { buildAuthorizeUrl, startOidc } from "@/lib/oidc";
import { sealOidc } from "@/lib/session";
import { safeReturnTo } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  const config = loadConfig();
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  if (!sessionSecretReady(config) || !config.accountClientSecret) {
    return NextResponse.redirect(new URL("/?error=login-unconfigured", config.origin));
  }
  const { start, challenge } = startOidc(returnTo);
  const response = NextResponse.redirect(buildAuthorizeUrl(config, start, challenge));
  applyAuthCookies(response, { oidc: sealOidc(start, config.sessionSecret) }, config);
  return response;
}
