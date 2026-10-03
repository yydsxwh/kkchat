import { assertMutation, errorResponse, json, requireUser } from "@/lib/http";
import { markConversationViewing } from "@/lib/viewing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 告诉服务器：我正在看这个会话。短时间过期，离开页面就不再续。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertMutation(request);
    const session = await requireUser(request);
    const { id } = await context.params;
    markConversationViewing(session.accountSub, id);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
