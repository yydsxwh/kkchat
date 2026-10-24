import { z } from "zod";
import { getNativeAuthService } from "@/lib/app-service";
import { clientIp, errorResponse, json } from "@/lib/http";
import { nativeAuthLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(["android", "ios"]),
  codeChallenge: z.string().min(43).max(128),
  deviceName: z.string().max(80).optional(),
  /** login：切换或添加账号时强制账号中心重新登录。 */
  prompt: z.enum(["login"]).optional(),
});

export async function POST(request: Request) {
  try {
    if (!nativeAuthLimiter.allow(`start:${clientIp(request)}`)) return json({ error: "操作太频繁" }, 429);
    const input = schema.parse(await request.json());
    return json(await getNativeAuthService().start(input));
  } catch (error) {
    return errorResponse(error);
  }
}
