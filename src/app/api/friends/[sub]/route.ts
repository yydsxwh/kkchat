import { z } from "zod";
import { getFriendService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { friendLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const remarkSchema = z.object({ remark: z.string().max(80) });

/** 设置自己的备注。不会改对方公开资料。 */
export async function PATCH(request: Request, context: { params: Promise<{ sub: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const { sub } = await context.params;
    const input = remarkSchema.parse(await request.json());
    return json(await getFriendService().setRemark(actor.accountSub, decodeURIComponent(sub), input.remark));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 删除好友：双方关系解除，聊天记录保留，重加需要新申请。 */
export async function DELETE(request: Request, context: { params: Promise<{ sub: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!friendLimiter.allow(`friend:${actor.accountSub}`)) return json({ error: "操作太频繁" }, 429);
    const { sub } = await context.params;
    return json(await getFriendService().remove(actor.accountSub, decodeURIComponent(sub)));
  } catch (error) {
    return errorResponse(error);
  }
}
