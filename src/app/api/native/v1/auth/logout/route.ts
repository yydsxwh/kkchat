import { getNativeAuthService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** App 退出：撤销当前设备会话、推送绑定和未用的刷新凭证，并断开实时连接。 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (actor.kind !== "native") return json({ error: "只用于 App 设备会话" }, 400);
    await getNativeAuthService().revokeSession(actor.sessionId, "logout");
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
