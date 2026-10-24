import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { REPORT_REASONS } from "@/lib/domain";
import { errorResponse, json } from "@/lib/http";
import { createReport, listMyReports } from "@/lib/social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  targetSub: z.string(),
  reason: z.enum(REPORT_REASONS),
  detail: z.string().max(2000).optional(),
  messageId: z.string().max(80).optional(),
  conversationId: z.string().max(80).optional(),
});

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    return json({ reports: await listMyReports(prisma, actor.accountSub) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const input = schema.parse(await request.json());
    const report = await createReport(prisma, { reporterSub: actor.accountSub, ...input });
    return json({ report });
  } catch (error) {
    return errorResponse(error);
  }
}
