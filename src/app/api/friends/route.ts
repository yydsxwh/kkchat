import { getFriendService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    return json({ friends: await getFriendService().listFriends(actor.accountSub) });
  } catch (error) {
    return errorResponse(error);
  }
}
