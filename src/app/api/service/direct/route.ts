import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { conversationPath } from "@/lib/chat-service";
import { loadConfig } from "@/lib/config";
import { isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  senderSub: z.string(),
  recipientSub: z.string(),
  businessType: z.string().max(40).nullable().optional(),
  businessRefId: z.string().max(80).nullable().optional(),
  senderProfile: profileSchema(),
  recipientProfile: profileSchema(),
});

function profileSchema() {
  return z
    .object({
      displayName: z.string().max(80).optional(),
      kkNumber: z.number().int().positive().nullable().optional(),
      username: z.string().max(32).nullable().optional(),
      avatarUrl: z.string().max(500).optional(),
    })
    .optional();
}

export async function POST(request: Request) {
  try {
    const { product } = authorizeService(request);
    const body = schema.parse(await request.json());
    if (!isUserPublicId(body.senderSub) || !isUserPublicId(body.recipientSub)) {
      return json({ error: "账号标识无效" }, 400);
    }
    const service = getChatService();
    await saveProfile(service, body.senderSub, body.senderProfile);
    await saveProfile(service, body.recipientSub, body.recipientProfile);
    const conversation = await service.ensureDirect({
      senderSub: body.senderSub,
      recipientSub: body.recipientSub,
      sourceProduct: product,
      createdBySub: body.senderSub,
      businessType: body.businessType,
      businessRefId: body.businessRefId,
    });
    const href = conversationPath(conversation.id);
    return json({
      conversationId: conversation.id,
      href,
      url: `${loadConfig().origin}${href}`,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function saveProfile(
  service: ReturnType<typeof getChatService>,
  accountSub: string,
  profile: z.infer<ReturnType<typeof profileSchema>>,
) {
  if (!profile) return;
  await service.upsertProjection({
    accountSub,
    displayName: profile.displayName || "用户",
    kkNumber: profile.kkNumber ?? null,
    username: profile.username ?? null,
    avatarUrl: profile.avatarUrl || "",
    publicRole: null,
    profileUpdatedAt: new Date(),
  });
}
