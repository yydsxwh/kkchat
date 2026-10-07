import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { conversationPath } from "@/lib/chat-service";
import { loadConfig } from "@/lib/config";
import { isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";
import { dispatchWechatPlans } from "@/lib/official-notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  senderSub: z.string(),
  conversationId: z.string().min(1),
  body: z.string(),
  courseName: z.string().max(40),
  idempotencyKey: z.string().max(80),
  senderName: z.string().max(40).optional(),
});

/** 老师公告。普通群聊仍走消息接口；这里才会记成课程通知。 */
export async function POST(request: Request) {
  try {
    const { product } = authorizeService(request);
    const body = schema.parse(await request.json());
    if (!isUserPublicId(body.senderSub)) return json({ error: "账号标识无效" }, 400);
    const service = getChatService();
    if (body.senderName?.trim()) {
      await service.upsertProjection({
        accountSub: body.senderSub,
        displayName: body.senderName.trim(),
        kkNumber: null,
        username: null,
        avatarUrl: "",
        publicRole: null,
        profileUpdatedAt: new Date(),
      });
    }
    const result = await service.sendMessage({
      senderSub: body.senderSub,
      conversationId: body.conversationId,
      body: body.body,
      type: "TEXT",
      sourceProduct: product,
      idempotencyKey: body.idempotencyKey,
      metadata: { notice: "course-announcement", courseName: body.courseName },
    });
    const href = conversationPath(result.conversation.id);
    const url = `${loadConfig().origin}${href}`;
    const wechatPlanned = result.duplicate ? 0 : await dispatchWechatPlans(result.externalNotifies, url);
    return json({
      conversationId: result.conversation.id,
      duplicate: result.duplicate,
      href,
      url,
      wechatPlanned,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
