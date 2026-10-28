import { z } from "zod";
import { getFriendService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { FRIEND_SOURCES } from "@/lib/friend-service";
import { errorResponse, json } from "@/lib/http";
import { friendLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  addresseeSub: z.string(),
  message: z.string().max(500).optional(),
  source: z.enum(FRIEND_SOURCES).optional(),
  clientRequestId: z.string().max(80).optional(),
});

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    return json(await getFriendService().listRequests(actor.accountSub));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!friendLimiter.allow(`friend:${actor.accountSub}`)) return json({ error: "操作太频繁" }, 429);
    const input = schema.parse(await request.json());
    const result = await getFriendService().sendRequest({
      requesterSub: actor.accountSub,
      addresseeSub: input.addresseeSub,
      message: input.message,
      source: input.source,
      clientRequestId: input.clientRequestId,
    });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
