import { getChatService } from "@/lib/app-service";
import { errorResponse, json, requireUser } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser(request);
    const { id } = await context.params;
    const thread = await getChatService().getThread(session.accountSub, id);
    return json(thread);
  } catch (error) {
    return errorResponse(error);
  }
}
