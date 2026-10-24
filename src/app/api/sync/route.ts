import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { readEvents } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 增量同步。since 是客户端处理过的最大 seq。
 * resyncRequired=true 时客户端要重新拉会话列表、好友、申请等全量状态，再从 latestSeq 继续。
 */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const url = new URL(request.url);
    const since = Number(url.searchParams.get("since") || "0");
    const limit = Number(url.searchParams.get("limit") || "200");
    return json(await readEvents(prisma, actor.accountSub, since, Number.isFinite(limit) ? limit : 200));
  } catch (error) {
    return errorResponse(error);
  }
}
