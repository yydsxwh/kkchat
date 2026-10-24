import { getChatService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const { id } = await context.params;
    const message = await getChatService().recall(actor.accountSub, id);
    return json({ message });
  } catch (error) {
    return errorResponse(error);
  }
}
