import { z } from "zod";
import { getFriendService } from "@/lib/app-service";
import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { clientIp, errorResponse, json } from "@/lib/http";
import { friendLimiter, inviteLimiter } from "@/lib/rate-limit";
import { resolveInvite, resolveInviteOwnerSub } from "@/lib/social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 解析邀请：返回邀请人的公开资料与当前关系。不授予聊天记录读取权限。 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const actor = await requireActor(request);
    if (!inviteLimiter.allow(`resolve:${clientIp(request)}`)) return json({ error: "操作太频繁" }, 429);
    const { token } = await context.params;
    const invite = await resolveInvite(prisma, token);
    const relationship = await getFriendService().relationship(actor.accountSub, invite.owner.accountSub);
    return json({ owner: invite.owner, expiresAt: invite.expiresAt, relationship });
  } catch (error) {
    return errorResponse(error);
  }
}

const schema = z.object({ message: z.string().max(500).optional(), clientRequestId: z.string().max(80).optional() });

/** 扫码后由用户确认才发申请，不会自动成为好友。 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!friendLimiter.allow(`friend:${actor.accountSub}`)) return json({ error: "操作太频繁" }, 429);
    const { token } = await context.params;
    const ownerSub = await resolveInviteOwnerSub(prisma, token);
    const input = schema.parse(await request.json());
    const result = await getFriendService().sendRequest({
      requesterSub: actor.accountSub,
      addresseeSub: ownerSub,
      message: input.message,
      source: "link",
      clientRequestId: input.clientRequestId,
      viaInvite: true,
    });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
