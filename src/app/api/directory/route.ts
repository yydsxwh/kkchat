import { searchAccountDirectory } from "@/lib/directory";
import { errorResponse, json, requireUser } from "@/lib/http";
import { searchLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await requireUser(request);
    if (!searchLimiter.allow(`search:${session.accountSub}`)) return json({ error: "搜索太频繁" }, 429);
    const url = new URL(request.url);
    const users = await searchAccountDirectory({
      kkNumber: url.searchParams.get("kkNumber"),
      username: url.searchParams.get("username"),
      q: url.searchParams.get("q"),
    });
    return json({ users: users.filter((user) => user.sub && user.sub !== session.accountSub) });
  } catch (error) {
    return errorResponse(error);
  }
}
