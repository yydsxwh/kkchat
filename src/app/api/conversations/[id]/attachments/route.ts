import { prisma } from "@/lib/db";
import { ATTACHMENT_MAX_BYTES, uploadAttachment } from "@/lib/attachments";
import { requireActor } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";
import { uploadLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 上传附件（multipart/form-data：file、kind=image|file、clientUploadId）。
 * 上传成功不等于已发送：还要再用 attachmentId 发一条 IMAGE / FILE 消息。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, { mutation: true });
    if (!uploadLimiter.allow(actor.accountSub)) return json({ error: "上传太频繁" }, 429);
    const length = Number(request.headers.get("content-length") || "0");
    if (length > ATTACHMENT_MAX_BYTES + 64 * 1024) return json({ error: "文件不能超过 20MB" }, 413);
    const { id } = await context.params;
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "缺少文件" }, 400);
    const kind = form.get("kind") === "image" ? "image" : "file";
    const attachment = await uploadAttachment(prisma, {
      ownerSub: actor.accountSub,
      conversationId: id,
      fileName: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
      kind,
      clientUploadId: typeof form.get("clientUploadId") === "string" ? String(form.get("clientUploadId")) : null,
    });
    return json({
      attachment: {
        id: attachment.id,
        name: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.sizeBytes,
        width: attachment.width,
        height: attachment.height,
        status: attachment.status,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
