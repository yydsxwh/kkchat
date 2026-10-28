import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { isModerator } from "@/lib/social";
import { latestSeq } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const user = await prisma.userProjection.findUnique({ where: { accountSub: actor.accountSub } });
    if (!user) return json({ error: "请先登录" }, 401);
    return json({
      accountSub: user.accountSub,
      kkNumber: user.kkNumber,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      publicRole: user.publicRole,
      moderator: await isModerator(prisma, user.accountSub),
      session: { kind: actor.kind, id: actor.kind === "native" ? actor.sessionId : undefined },
      syncSeq: await latestSeq(prisma, user.accountSub),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
