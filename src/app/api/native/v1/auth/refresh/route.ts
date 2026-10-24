import { z } from "zod";
import { getNativeAuthService } from "@/lib/app-service";
import { clientIp, errorResponse, json } from "@/lib/http";
import { refreshLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ refreshToken: z.string().max(200), requestId: z.string().min(8).max(80) });

export async function POST(request: Request) {
  try {
    if (!refreshLimiter.allow(`refresh:${clientIp(request)}`)) return json({ error: "操作太频繁" }, 429);
    const input = schema.parse(await request.json());
    return json(await getNativeAuthService().refresh(input));
  } catch (error) {
    return errorResponse(error);
  }
}
