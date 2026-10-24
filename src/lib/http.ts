import { NextResponse } from "next/server";
import { ChatError } from "./domain";
import { loadConfig, sessionSecretReady, isSourceProduct, type KkchatConfig } from "./config";
import { tokensMatch, readCookie } from "./crypto";
import { CSRF_COOKIE, OIDC_COOKIE, SESSION_COOKIE, cookieBase, newCsrfToken, readSession, type SessionRecord } from "./session";
import { OidcError } from "./oidc";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/** 机器可读的错误码（App 据此决定刷新、重新授权还是提示），对应给人看的中文说明。 */
const CODE_MESSAGES: Record<string, string> = {
  reauth_required: "需要重新登录账号中心",
  refresh_invalid: "登录已失效，请重新登录",
  refresh_expired: "登录已过期，请重新登录",
  refresh_reused: "登录已失效，请重新登录",
  session_revoked: "登录已在别处退出，请重新登录",
};

export function errorResponse(error: unknown) {
  if (error instanceof ChatError) {
    const code = /^[a-z_]+(:[a-z_]+)?$/.test(error.message) ? error.message : undefined;
    if (code) {
      const base = code.split(":")[0];
      const message = CODE_MESSAGES[base] || (base === "restart_auth" ? "登录没有完成，请重新登录" : "请求失败");
      return json({ error: message, code }, error.status);
    }
    return json({ error: error.message }, error.status);
  }
  if (error instanceof OidcError) return json({ error: "登录校验失败" }, 400);
  if (error instanceof Error && error.name === "ZodError") return json({ error: "请求格式不正确" }, 400);
  if (error instanceof SyntaxError) return json({ error: "请求格式不正确" }, 400);
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message.slice(0, 300) : "";
  console.error(`[kkchat] unexpected ${name}: ${message}`);
  return json({ error: "暂时无法完成操作" }, 500);
}

export function clientIp(request: Request) {
  return (request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0] || "local").trim().slice(0, 64);
}

export async function requireUser(request: Request): Promise<SessionRecord> {
  const session = await readSession(request);
  if (!session) throw new ChatError(401, "请先登录");
  return session;
}

export function assertMutation(request: Request, config = loadConfig()) {
  const origin = request.headers.get("origin");
  if (origin && origin !== config.origin) throw new ChatError(403, "来源不被接受");
  const cookie = readCookie(request.headers.get("cookie"), CSRF_COOKIE);
  const header = request.headers.get("x-kkchat-csrf") || "";
  if (!cookie || !tokensMatch(header, cookie)) throw new ChatError(403, "请求校验失败");
}

export function applyAuthCookies(
  response: NextResponse,
  input: { sessionId?: string; csrf?: string; oidc?: string; clearOidc?: boolean; clearSession?: boolean },
  config = loadConfig(),
) {
  const base = cookieBase(config);
  if (input.sessionId) {
    response.cookies.set(SESSION_COOKIE, input.sessionId, { ...base, maxAge: 30 * 24 * 60 * 60 });
  }
  if (input.clearSession) response.cookies.set(SESSION_COOKIE, "", { ...base, maxAge: 0 });
  if (input.csrf) {
    response.cookies.set(CSRF_COOKIE, input.csrf, {
      httpOnly: false,
      secure: config.cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
  }
  if (input.oidc && sessionSecretReady(config)) {
    response.cookies.set(OIDC_COOKIE, input.oidc, { ...base, path: "/api/auth", maxAge: 600 });
  }
  if (input.clearOidc) response.cookies.set(OIDC_COOKIE, "", { ...base, path: "/api/auth", maxAge: 0 });
  return response;
}

export function freshCsrf() {
  return newCsrfToken();
}

export function authorizeService(request: Request, config: KkchatConfig = loadConfig()): { product: string } {
  const product = (request.headers.get("x-kkchat-product") || "").trim().toLowerCase();
  if (!isSourceProduct(product) || product === "kkchat") {
    throw new ChatError(400, "缺少有效的产品标识");
  }
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const expected = config.serviceTokens[product] || config.serviceToken;
  if (!expected || !tokensMatch(token, expected)) throw new ChatError(401, "服务凭证无效");
  return { product };
}
