import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { conversationPath } from "@/lib/chat-service";
import { errorResponse, json } from "@/lib/http";
import { searchLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 只收对方的 sub。对方昵称、KK 号由服务端向账号中心查，不接受客户端提交。 */
const startSchema = z.object({
  peerSub: z.string().optional(),
  recipientSub: z.string().optional(),
});

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const items = await getChatService().listInbox(actor.accountSub);
    return json({ conversations: items });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!searchLimiter.allow(`direct:${actor.accountSub}`)) return json({ error: "操作太频繁" }, 429);
    const body = startSchema.parse(await request.json());
    const peer = body.peerSub || body.recipientSub || "";
    const { conversation } = await getChatService().openDirectForUser(actor.accountSub, peer);
    return json({ conversationId: conversation.id, href: conversationPath(conversation.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
