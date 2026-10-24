import { z } from "zod";
import { getNativeAuthService } from "@/lib/app-service";
import { requireActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  provider: z.enum(["APNS", "FCM"]),
  token: z.string().min(16).max(4096),
  environment: z.enum(["sandbox", "production"]).optional(),
});

/**
 * 登记系统推送令牌，绑定到当前设备会话。
 * 只登记，不代表后台推送已接通：发送端需要 APNs / FCM 凭证，见发布报告。
 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (actor.kind !== "native") return json({ error: "只用于 App 设备会话" }, 400);
    const session = await prisma.deviceSession.findUniqueOrThrow({ where: { id: actor.sessionId } });
    const input = schema.parse(await request.json());
    return json(await getNativeAuthService().registerPush(session, input));
  } catch (error) {
    return errorResponse(error);
  }
}
