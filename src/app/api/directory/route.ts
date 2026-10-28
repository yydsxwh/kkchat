import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { searchLimiter } from "@/lib/rate-limit";
import { searchUsers } from "@/lib/social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 查找用户：kkNumber / username 精确，q 为昵称辅助搜索。只返回公开字段。 */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    if (!searchLimiter.allow(`search:${actor.accountSub}`)) return json({ error: "搜索太频繁" }, 429);
    const url = new URL(request.url);
    const users = await searchUsers(prisma, actor.accountSub, {
      kkNumber: url.searchParams.get("kkNumber"),
      username: url.searchParams.get("username"),
      q: url.searchParams.get("q"),
    });
    return json({ users });
  } catch (error) {
    return errorResponse(error);
  }
}
