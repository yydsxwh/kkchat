import { z } from "zod";
import { getNativeAuthService } from "@/lib/app-service";
import { clientIp, errorResponse, json } from "@/lib/http";
import { refreshLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ refreshToken: z.string().max(200), requestId: z.string().min(8).max(80) });

export async function POST(request: Request) {
  try {
    const limited = await refreshLimiter.allowShared(`refresh:${clientIp(request)}`);
    if (!limited.ok) return json({ error: "操作太频繁" }, 429, { "Retry-After": String(limited.retryAfterSec) });
    const input = schema.parse(await request.json());
    return json(await getNativeAuthService().refresh(input));
  } catch (error) {
    return errorResponse(error);
  }
}
