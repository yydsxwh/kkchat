import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { conversationPath } from "@/lib/chat-service";
import { loadConfig } from "@/lib/config";
import { errorResponse, json } from "@/lib/http";
import { dispatchWechatPlans } from "@/lib/official-notify";
import { sendLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  body: z.string().max(8000).default(""),
  type: z.enum(["TEXT", "IMAGE", "FILE"]).optional(),
  attachmentId: z.string().max(80).optional(),
  /** 客户端固定的消息 ID。超时重试、App 重启、离线队列重放都用同一个值。 */
  clientMessageId: z.string().max(80).optional(),
  idempotencyKey: z.string().max(80).optional(),
});

function intParam(value: string | null): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request);
    const { id } = await context.params;
    const url = new URL(request.url);
    const page = await getChatService().listMessages(actor.accountSub, id, {
      beforeSeq: intParam(url.searchParams.get("beforeSeq")),
      afterSeq: intParam(url.searchParams.get("afterSeq")),
      limit: intParam(url.searchParams.get("limit")) ?? undefined,
    });
    return json(page);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!sendLimiter.allow(actor.accountSub)) return json({ error: "发送太频繁" }, 429);
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const result = await getChatService().sendMessage({
      actor: { kind: "user", sub: actor.accountSub },
      senderSub: actor.accountSub,
      conversationId: id,
      body: input.body,
      type: input.type || "TEXT",
      metadata: input.attachmentId ? { attachmentId: input.attachmentId } : undefined,
      idempotencyKey: input.clientMessageId || input.idempotencyKey,
    });
    if (!result.duplicate) {
      const url = `${loadConfig().origin}${conversationPath(result.conversationId)}`;
      void dispatchWechatPlans(result.externalNotifies, url).catch(() => undefined);
    }
    return json({ message: result.message, duplicate: result.duplicate });
  } catch (error) {
    return errorResponse(error);
  }
}
