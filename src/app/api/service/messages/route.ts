import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { conversationPath, toPublicMessage } from "@/lib/chat-service";
import { loadConfig } from "@/lib/config";
import { isMessageType, isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";
import { notifyOfficialMessage } from "@/lib/official-notify";
import { serviceLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  senderSub: z.string(),
  recipientSub: z.string().optional(),
  conversationId: z.string().optional(),
  body: z.string(),
  messageType: z.string().optional(),
  businessType: z.string().max(40).nullable().optional(),
  businessRefId: z.string().max(80).nullable().optional(),
  idempotencyKey: z.string().max(80),
  metadata: z.record(z.string(), z.unknown()).optional(),
  notifyWechat: z.boolean().optional(),
  senderName: z.string().max(40).optional(),
});

export async function POST(request: Request) {
  try {
    const { product } = authorizeService(request);
    if (!serviceLimiter.allow(product)) return json({ error: "调用太频繁" }, 429);
    const body = schema.parse(await request.json());
    if (!isUserPublicId(body.senderSub)) return json({ error: "账号标识无效" }, 400);
    if (!body.conversationId && !body.recipientSub) return json({ error: "缺少接收方" }, 400);
    if (body.recipientSub && !isUserPublicId(body.recipientSub)) return json({ error: "账号标识无效" }, 400);
    const messageType = body.messageType || "TEXT";
    if (!isMessageType(messageType)) return json({ error: "不支持的消息类型" }, 400);
    const result = await getChatService().sendMessage({
      senderSub: body.senderSub,
      recipientSub: body.recipientSub,
      conversationId: body.conversationId,
      body: body.body,
      type: messageType,
      metadata: body.metadata,
      sourceProduct: product,
      idempotencyKey: body.idempotencyKey,
      businessType: body.businessType,
      businessRefId: body.businessRefId,
    });
    const href = conversationPath(result.conversation.id);
    const url = `${loadConfig().origin}${href}`;
    if (body.notifyWechat && body.recipientSub && !result.duplicate) {
      await notifyOfficialMessage({
        recipientSub: body.recipientSub,
        senderName: body.senderName || "KKChat",
        excerpt: body.body,
        conversationUrl: url,
      });
    }
    return json({
      conversationId: result.conversation.id,
      duplicate: result.duplicate,
      href,
      url,
      message: toPublicMessage(result.message, []),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
