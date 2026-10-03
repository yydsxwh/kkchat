import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { assertMutation, errorResponse, json, requireUser } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  title: z.string().max(80),
  memberSubs: z.array(z.string()).max(50),
});

export async function POST(request: Request) {
  try {
    assertMutation(request);
    const session = await requireUser(request);
    const body = schema.parse(await request.json());
    const conversation = await getChatService().createGroup({
      creatorSub: session.accountSub,
      title: body.title,
      memberSubs: body.memberSubs,
      sourceProduct: "kkchat",
    });
    return json({ conversationId: conversation.id, href: `/app/conversations/${conversation.id}` });
  } catch (error) {
    return errorResponse(error);
  }
}
