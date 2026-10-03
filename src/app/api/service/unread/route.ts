import { getChatService } from "@/lib/app-service";
import { isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    authorizeService(request);
    const accountSub = new URL(request.url).searchParams.get("accountSub") || "";
    if (!isUserPublicId(accountSub)) return json({ error: "账号标识无效" }, 400);
    const count = await getChatService().totalUnread(accountSub);
    return json({ accountSub, count });
  } catch (error) {
    return errorResponse(error);
  }
}
