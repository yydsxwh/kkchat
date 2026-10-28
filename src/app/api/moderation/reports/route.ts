import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { listReportsForModerator } from "@/lib/social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const status = new URL(request.url).searchParams.get("status") || "OPEN";
    const safe = ["OPEN", "RESOLVED", "DISMISSED"].includes(status) ? status : "OPEN";
    return json({ reports: await listReportsForModerator(prisma, actor.accountSub, safe) });
  } catch (error) {
    return errorResponse(error);
  }
}
