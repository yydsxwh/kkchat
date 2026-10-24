import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { getPrivacy, updatePrivacy } from "@/lib/social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  discoverByKkNumber: z.boolean().optional(),
  discoverByUsername: z.boolean().optional(),
  discoverByName: z.boolean().optional(),
  allowFriendRequests: z.boolean().optional(),
  hideNotificationContent: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    return json(await getPrivacy(prisma, actor.accountSub));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const input = schema.parse(await request.json());
    return json(await updatePrivacy(prisma, actor.accountSub, input));
  } catch (error) {
    return errorResponse(error);
  }
}
