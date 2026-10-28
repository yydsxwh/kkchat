import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** upToSeq：客户端前台真正看到的最后一条消息序号。不传则读到当前最新。 */
const schema = z.object({ upToSeq: z.number().int().nonnegative().optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const { id } = await context.params;
    const raw = await request.text();
    const input = schema.parse(raw ? JSON.parse(raw) : {});
    const result = await getChatService().markRead(actor.accountSub, id, input.upToSeq ?? null);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
