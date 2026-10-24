import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { conversationPath } from "@/lib/chat-service";
import { loadConfig } from "@/lib/config";
import { isMessageType, isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";
import { dispatchWechatPlans } from "@/lib/official-notify";
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

/**
 * 产品后端代表已登录的业务用户发消息。私聊同样经过统一权限入口：拉黑一律拒绝，
 * 伪造 SYSTEM 类型或来源产品都要先过服务凭证。
 */
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
      actor: { kind: "service", product },
      senderSub: body.senderSub,
      recipientSub: body.recipientSub,
      conversationId: body.conversationId,
      body: body.body,
      type: messageType,
      metadata: body.metadata,
      idempotencyKey: body.idempotencyKey,
      businessType: body.businessType,
      businessRefId: body.businessRefId,
      senderHintName: body.senderName,
    });
    const href = conversationPath(result.conversationId);
    const url = `${loadConfig().origin}${href}`;
    const wechatPlanned = result.duplicate ? 0 : await dispatchWechatPlans(result.externalNotifies, url);
    return json({
      conversationId: result.conversationId,
      duplicate: result.duplicate,
      href,
      url,
      wechatPlanned,
      message: result.message,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
