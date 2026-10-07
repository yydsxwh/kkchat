import { getChatService } from "@/lib/app-service";
import { isUserPublicId } from "@/lib/domain";
import { authorizeService, errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 给日事等产品拉取「最近私聊」。不是好友表，也不包含手机号和邮箱。 */
export async function GET(request: Request) {
  try {
    authorizeService(request);
    const accountSub = new URL(request.url).searchParams.get("accountSub") || "";
    if (!isUserPublicId(accountSub)) return json({ error: "账号标识无效" }, 400);
    const contacts = await getChatService().listDirectContacts(accountSub);
    return json({ contacts });
  } catch (error) {
    return errorResponse(error);
  }
}
