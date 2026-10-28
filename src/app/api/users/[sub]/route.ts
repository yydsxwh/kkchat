import { getFriendService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 用户资料与当前关系：已添加 / 已申请 / 对方申请中 / 已拉黑。 */
export async function GET(request: Request, context: { params: Promise<{ sub: string }> }) {
  try {
    const actor = await requireActor(request);
    const { sub } = await context.params;
    return json(await getFriendService().relationship(actor.accountSub, decodeURIComponent(sub)));
  } catch (error) {
    return errorResponse(error);
  }
}
