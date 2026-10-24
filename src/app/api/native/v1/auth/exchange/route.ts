import { z } from "zod";
import { getNativeAuthService } from "@/lib/app-service";
import { clientIp, errorResponse, json } from "@/lib/http";
import { nativeAuthLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  transactionId: z.string().max(80),
  transactionSecret: z.string().max(200),
  code: z.string().max(500),
  state: z.string().max(200),
  codeVerifier: z.string().max(200),
  appVersion: z.string().max(40).optional(),
});

/** 一次性登录交换。响应里的凭证只在这一次出现；日志不记录授权码与令牌。 */
export async function POST(request: Request) {
  try {
    if (!nativeAuthLimiter.allow(`exchange:${clientIp(request)}`)) return json({ error: "操作太频繁" }, 429);
    const input = schema.parse(await request.json());
    const result = await getNativeAuthService().exchange(input);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
