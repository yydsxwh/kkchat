import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { markConversationViewing } from "@/lib/viewing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 告诉服务器：我正在看这个会话。短时间过期，离开页面就不再续。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const { id } = await context.params;
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_accountSub: { conversationId: id, accountSub: actor.accountSub } },
      select: { joinStatus: true },
    });
    if (member?.joinStatus === "ACTIVE") markConversationViewing(actor.accountSub, id);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
