import { getNativeAuthService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const sessions = await getNativeAuthService().listSessions(actor.accountSub);
    return json({ sessions, current: actor.kind === "native" ? actor.sessionId : null });
  } catch (error) {
    return errorResponse(error);
  }
}
