import { z } from "zod";
import { getChatService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    const thread = await getChatService().getThread(actor.accountSub, id, {
      beforeSeq: intParam(url.searchParams.get("beforeSeq")),
      limit: intParam(url.searchParams.get("limit")) ?? undefined,
    });
    return json(thread);
  } catch (error) {
    return errorResponse(error);
  }
}

const prefsSchema = z.object({ pinned: z.boolean().optional(), muted: z.boolean().optional() });

/** 置顶、免打扰只属于自己。 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const { id } = await context.params;
    const prefs = prefsSchema.parse(await request.json());
    return json(await getChatService().setConversationPrefs(actor.accountSub, id, prefs));
  } catch (error) {
    return errorResponse(error);
  }
}
