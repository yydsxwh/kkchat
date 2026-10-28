import { prisma } from "@/lib/db";
import { readAttachment } from "@/lib/attachments";
import { requireActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request);
    const { id } = await context.params;
    const { attachment, bytes } = await readAttachment(prisma, actor.accountSub, id);
    const inline = attachment.mimeType.startsWith("image/");
    const encoded = encodeURIComponent(attachment.fileName);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": attachment.mimeType,
        "content-length": String(bytes.length),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
