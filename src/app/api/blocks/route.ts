import { z } from "zod";
import { getFriendService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { friendLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ targetSub: z.string() });

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    return json({ blocks: await getFriendService().listBlocks(actor.accountSub) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const limited = await friendLimiter.allowShared(`friend:${actor.accountSub}`);
    if (!limited.ok) return json({ error: "操作太频繁" }, 429, { "Retry-After": String(limited.retryAfterSec) });
    const input = schema.parse(await request.json());
    return json(await getFriendService().block(actor.accountSub, input.targetSub));
  } catch (error) {
    return errorResponse(error);
  }
}
