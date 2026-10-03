import { getChatService } from "@/lib/app-service";
import { assertMutation, errorResponse, json, requireUser } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertMutation(request);
    const session = await requireUser(request);
    const { id } = await context.params;
    const result = await getChatService().markRead(session.accountSub, id);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
