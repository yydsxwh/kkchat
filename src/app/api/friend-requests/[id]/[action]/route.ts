import { getFriendService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { friendLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** accept：只有接收者；reject：只有接收者；cancel：只有发起人。重复请求不产生额外副作用。 */
export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!friendLimiter.allow(`friend:${actor.accountSub}`)) return json({ error: "操作太频繁" }, 429);
    const { id, action } = await context.params;
    const friends = getFriendService();
    if (action === "accept") return json(await friends.accept(actor.accountSub, id));
    if (action === "reject") return json(await friends.reject(actor.accountSub, id));
    if (action === "cancel") return json(await friends.cancel(actor.accountSub, id));
    return json({ error: "未知操作" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}
