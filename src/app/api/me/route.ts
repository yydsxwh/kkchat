import { prisma } from "@/lib/db";
import { errorResponse, json, requireUser } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await requireUser(request);
    const user = await prisma.userProjection.findUnique({ where: { accountSub: session.accountSub } });
    if (!user) return json({ error: "请先登录" }, 401);
    return json({
      accountSub: user.accountSub,
      kkNumber: user.kkNumber,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      publicRole: user.publicRole,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
