import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { resolveReport } from "@/lib/social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ status: z.enum(["RESOLVED", "DISMISSED"]), resolution: z.string().max(500).optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    return json(await resolveReport(prisma, actor.accountSub, id, input));
  } catch (error) {
    return errorResponse(error);
  }
}
