import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { conversationPath } from "@/lib/chat-service";
import { loadConfig } from "@/lib/config";
import { isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  creatorSub: z.string(),
  title: z.string().max(80),
  memberSubs: z.array(z.string()).max(500),
  businessType: z.string().max(40),
  businessRefId: z.string().max(80),
  profiles: z
    .array(
      z.object({
        accountSub: z.string(),
        displayName: z.string().max(80).optional(),
        kkNumber: z.number().int().positive().nullable().optional(),
        username: z.string().max(32).nullable().optional(),
        avatarUrl: z.string().max(500).optional(),
      }),
    )
    .max(500)
    .optional(),
});

/** 课程群。profiles 只作账号中心暂不可达时的占位昵称，不覆盖账号中心资料。 */
export async function POST(request: Request) {
  try {
    const { product } = authorizeService(request);
    const body = schema.parse(await request.json());
    if (!isUserPublicId(body.creatorSub) || body.memberSubs.some((item) => !isUserPublicId(item))) {
      return json({ error: "账号标识无效" }, 400);
    }
    const hints = new Map<string, string>();
    for (const profile of body.profiles || []) {
      if (isUserPublicId(profile.accountSub) && profile.displayName) hints.set(profile.accountSub, profile.displayName);
    }
    const conversation = await getChatService().ensureBusinessGroup({
      creatorSub: body.creatorSub,
      title: body.title,
      memberSubs: body.memberSubs,
      sourceProduct: product,
      businessType: body.businessType,
      businessRefId: body.businessRefId,
      hints,
    });
    const href = conversationPath(conversation.id);
    return json({ conversationId: conversation.id, href, url: `${loadConfig().origin}${href}` });
  } catch (error) {
    return errorResponse(error);
  }
}
