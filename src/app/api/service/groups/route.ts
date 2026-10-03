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

export async function POST(request: Request) {
  try {
    const { product } = authorizeService(request);
    const body = schema.parse(await request.json());
    if (!isUserPublicId(body.creatorSub) || body.memberSubs.some((item) => !isUserPublicId(item))) {
      return json({ error: "账号标识无效" }, 400);
    }
    const service = getChatService();
    const now = new Date();
    for (const profile of body.profiles || []) {
      if (!isUserPublicId(profile.accountSub)) continue;
      await service.upsertProjection({
        accountSub: profile.accountSub,
        displayName: profile.displayName || "用户",
        kkNumber: profile.kkNumber ?? null,
        username: profile.username ?? null,
        avatarUrl: profile.avatarUrl || "",
        publicRole: null,
        profileUpdatedAt: now,
      });
    }
    const conversation = await service.ensureBusinessGroup({
      creatorSub: body.creatorSub,
      title: body.title,
      memberSubs: body.memberSubs,
      sourceProduct: product,
      businessType: body.businessType,
      businessRefId: body.businessRefId,
      now,
    });
    const href = conversationPath(conversation.id);
    return json({ conversationId: conversation.id, href, url: `${loadConfig().origin}${href}` });
  } catch (error) {
    return errorResponse(error);
  }
}
