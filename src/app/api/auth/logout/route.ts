import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { applyAuthCookies, assertMutation } from "@/lib/http";
import { revokeSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const config = loadConfig();
  try {
    assertMutation(request, config);
    await revokeSession(request);
  } catch {
    // 退出失败也清掉浏览器上的会话，避免留下一个已经不可用的入口。
  }
  const response = NextResponse.redirect(new URL("/", config.origin), { status: 303 });
  applyAuthCookies(response, { clearSession: true, csrf: "" }, config);
  response.cookies.set("kkchat_csrf", "", { path: "/", maxAge: 0 });
  return response;
}
