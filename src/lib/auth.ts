import { getNativeAuthService } from "./app-service";
import { ChatError } from "./domain";
import { assertMutation } from "./http";
import { readSession } from "./session";

export type RequestActor = {
  accountSub: string;
  /** web：HttpOnly Cookie 会话；native：App 设备会话的 Bearer 凭证。 */
  kind: "web" | "native";
  sessionId: string;
};

function bearer(request: Request): string {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/**
 * 普通用户的身份只来自已验证的会话。请求体里的 actorSub、senderSub 一律不用。
 *
 * 带 Bearer 时只认设备会话，不再看 Cookie；浏览器跨站请求带不上自定义 Authorization 头，
 * 所以 Bearer 请求不需要 CSRF。没有 Bearer 时走原来的 Cookie 会话，写操作必须通过 CSRF 校验。
 */
export async function requireActor(request: Request, options: { mutation?: boolean } = {}): Promise<RequestActor> {
  const token = bearer(request);
  if (token) {
    const session = await getNativeAuthService().verifyAccess(token);
    if (!session) throw new ChatError(401, "登录已失效，请重新登录");
    return { accountSub: session.accountSub, kind: "native", sessionId: session.id };
  }
  if (options.mutation) assertMutation(request);
  const session = await readSession(request);
  if (!session) throw new ChatError(401, "请先登录");
  return { accountSub: session.accountSub, kind: "web", sessionId: session.id };
}

export async function actorStillValid(request: Request, actor: RequestActor): Promise<boolean> {
  if (actor.kind === "native") {
    const session = await getNativeAuthService().verifyAccess(bearer(request));
    return Boolean(session && session.id === actor.sessionId);
  }
  const current = await readSession(request);
  return Boolean(current && current.id === actor.sessionId);
}
