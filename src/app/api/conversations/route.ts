import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { isUserPublicId } from "@/lib/domain";
import { assertMutation, errorResponse, json, requireUser } from "@/lib/http";
import { searchLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const startSchema = z.object({
  recipientSub: z.string(),
  displayName: z.string().max(80).optional(),
  kkNumber: z.number().int().positive().nullable().optional(),
  username: z.string().max(32).nullable().optional(),
  avatarUrl: z.string().max(500).optional(),
});

export async function GET(request: Request) {
  try {
    const session = await requireUser(request);
    const items = await getChatService().listInbox(session.accountSub);
    return json({ conversations: items });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutation(request);
    const session = await requireUser(request);
    if (!searchLimiter.allow(`direct:${session.accountSub}`)) return json({ error: "操作太频繁" }, 429);
    const body = startSchema.parse(await request.json());
    if (!isUserPublicId(body.recipientSub)) return json({ error: "账号标识无效" }, 400);
    const service = getChatService();
    if (body.displayName || body.kkNumber || body.username) {
      await service.upsertProjection({
        accountSub: body.recipientSub,
        displayName: body.displayName || "用户",
        kkNumber: body.kkNumber ?? null,
        username: body.username ?? null,
        avatarUrl: body.avatarUrl || "",
        publicRole: null,
        profileUpdatedAt: new Date(),
      });
    }
    const conversation = await service.ensureDirect({
      senderSub: session.accountSub,
      recipientSub: body.recipientSub,
      sourceProduct: "kkchat",
      createdBySub: session.accountSub,
    });
    return json({ conversationId: conversation.id, href: `/app/conversations/${conversation.id}` });
  } catch (error) {
    return errorResponse(error);
  }
}
