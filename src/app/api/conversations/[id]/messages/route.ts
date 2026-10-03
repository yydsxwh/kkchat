import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { assertMutation, errorResponse, json, requireUser } from "@/lib/http";
import { sendLimiter } from "@/lib/rate-limit";
import { toPublicMessage } from "@/lib/chat-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  body: z.string(),
  idempotencyKey: z.string().max(80).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertMutation(request);
    const session = await requireUser(request);
    if (!sendLimiter.allow(session.accountSub)) return json({ error: "发送太频繁" }, 429);
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const result = await getChatService().sendMessage({
      senderSub: session.accountSub,
      conversationId: id,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      sourceProduct: "kkchat",
      type: "TEXT",
    });
    const members = [{ accountSub: session.accountSub, joinStatus: "ACTIVE", lastReadAt: null }];
    return json({ message: toPublicMessage(result.message, members), duplicate: result.duplicate });
  } catch (error) {
    return errorResponse(error);
  }
}
