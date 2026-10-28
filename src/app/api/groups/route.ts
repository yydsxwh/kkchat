import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { conversationPath } from "@/lib/chat-service";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  title: z.string().max(80),
  memberSubs: z.array(z.string()).max(50),
});

/** 普通用户建群只能拉自己的好友。 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const body = schema.parse(await request.json());
    const conversation = await getChatService().createGroup({
      creatorSub: actor.accountSub,
      title: body.title,
      memberSubs: body.memberSubs,
    });
    return json({ conversationId: conversation.id, href: conversationPath(conversation.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
