import { getChatService } from "@/lib/app-service";
import { assertMutation, errorResponse, json, requireUser } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertMutation(request);
    const session = await requireUser(request);
    const { id } = await context.params;
    const message = await getChatService().recall(session.accountSub, id);
    return json({ message });
  } catch (error) {
    return errorResponse(error);
  }
}
