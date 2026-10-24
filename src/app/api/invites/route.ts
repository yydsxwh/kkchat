import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { inviteLimiter } from "@/lib/rate-limit";
import { createInvite, revokeInvites } from "@/lib/social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 生成个人二维码/邀请链接。链接里只有短期邀请标识，不含任何会话凭证。 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!inviteLimiter.allow(`invite:${actor.accountSub}`)) return json({ error: "操作太频繁" }, 429);
    return json(await createInvite(prisma, actor.accountSub));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 让之前发出去的二维码和链接全部失效。 */
export async function DELETE(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    return json({ revoked: await revokeInvites(prisma, actor.accountSub) });
  } catch (error) {
    return errorResponse(error);
  }
}
