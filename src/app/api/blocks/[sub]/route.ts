import { getFriendService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ sub: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const { sub } = await context.params;
    return json(await getFriendService().unblock(actor.accountSub, decodeURIComponent(sub)));
  } catch (error) {
    return errorResponse(error);
  }
}
