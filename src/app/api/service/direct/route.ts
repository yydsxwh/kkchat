import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { conversationPath } from "@/lib/chat-service";
import { loadConfig } from "@/lib/config";
import { isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const profileSchema = z
  .object({
    displayName: z.string().max(80).optional(),
    kkNumber: z.number().int().positive().nullable().optional(),
    username: z.string().max(32).nullable().optional(),
    avatarUrl: z.string().max(500).optional(),
  })
  .optional();

const schema = z.object({
  senderSub: z.string(),
  recipientSub: z.string(),
  businessType: z.string().max(40).nullable().optional(),
  businessRefId: z.string().max(80).nullable().optional(),
  senderProfile: profileSchema,
  recipientProfile: profileSchema,
});

/**
 * 产品后端（主站、教务）建立业务私聊。会记一条 BUSINESS 授权，但任一方向拉黑时拒绝。
 * senderProfile / recipientProfile 只在账号中心目录暂时查不到时当占位昵称，不会覆盖账号中心资料。
 */
export async function POST(request: Request) {
  try {
    const { product } = authorizeService(request);
    const body = schema.parse(await request.json());
    if (!isUserPublicId(body.senderSub) || !isUserPublicId(body.recipientSub)) {
      return json({ error: "账号标识无效" }, 400);
    }
    const { conversation } = await getChatService().openDirectForService({
      product,
      senderSub: body.senderSub,
      recipientSub: body.recipientSub,
      businessType: body.businessType,
      businessRefId: body.businessRefId,
      senderHintName: body.senderProfile?.displayName,
      recipientHintName: body.recipientProfile?.displayName,
    });
    const href = conversationPath(conversation.id);
    return json({ conversationId: conversation.id, href, url: `${loadConfig().origin}${href}` });
  } catch (error) {
    return errorResponse(error);
  }
}
