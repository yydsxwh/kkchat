import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { loadConfig, sessionSecretReady } from "@/lib/config";
import { prisma } from "@/lib/db";
import { applyAuthCookies } from "@/lib/http";
import { buildAuthorizeUrl, startOidc } from "@/lib/oidc";
import { sealOidc } from "@/lib/session";
import { multiAccountTabsEnabled } from "@/lib/tab-decision";
import { safeReturnTo } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const config = loadConfig();
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  if (!sessionSecretReady(config) || !config.accountClientSecret) {
    return NextResponse.redirect(new URL("/?error=login-unconfigured", config.origin));
  }
  // With rollout flag off, keep the original single-account OAuth callback
  // and avoid requiring the new per-tab attempts table.
  if (!multiAccountTabsEnabled()) {
    const { start, challenge } = startOidc(returnTo);
    const sealed = sealOidc(start, config.sessionSecret);
    const response = NextResponse.redirect(buildAuthorizeUrl(config, start, challenge));
    applyAuthCookies(response, { oidc: sealed }, config);
    return response;
  }
  const tab = request.headers.get("x-yyds-tab") || "";
  const wantsJson = (request.headers.get("accept") || "").includes("application/json");
  if (!tab && !wantsJson) {
    const html = `<!doctype html><meta charset="utf-8"><title>登录</title><script>
      var id=""; try{id=sessionStorage.getItem("yyds.tab.v1")||"";}catch(e){}
      fetch(location.pathname+location.search,{headers:{"x-yyds-tab":id,"accept":"application/json"}})
        .then(function(r){return r.json();}).then(function(data){ if(data.url) location.replace(data.url); });
    </script>`;
    return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const { start, challenge } = startOidc(returnTo);
  const sealed = sealOidc(start, config.sessionSecret);
  await prisma.kkOidcAttempt.create({
    data: {
      stateHash: createHash("sha256").update(start.state).digest("hex"),
      sealed,
      tabContextId: tab.slice(0, 80),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  const authorize = buildAuthorizeUrl(config, start, challenge);
  if (wantsJson) return NextResponse.json({ url: authorize });
  const response = NextResponse.redirect(authorize);
  applyAuthCookies(response, { oidc: sealed }, config);
  return response;
}
