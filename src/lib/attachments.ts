import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Attachment, PrismaClient } from "@prisma/client";
import { accessError, directAccess } from "./access";
import { ChatError, cleanShortText, peerFromPairKey } from "./domain";
import { withTx } from "./tx";

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** 上传后一天还没发出去的附件视为孤立对象，删除文件。 */
export const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

export function attachmentRoot() {
  return path.resolve(process.env.KKCHAT_ATTACHMENT_DIR?.trim() || "./data/attachments");
}

/** 只看文件头判断图片类型，不信客户端声明。 */
export function sniffImage(bytes: Buffer): { mimeType: string; width: number | null; height: number | null } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString("ascii") === "GIF") {
    return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", width: null, height: null };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", ...jpegSize(bytes) };
  }
  return null;
}

function jpegSize(bytes: Buffer): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return { width: null, height: null };
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function safeFileName(raw: string) {
  const base = cleanShortText(raw, 120).replace(/[\\/:*?"<>|]+/g, "_");
  return base || "file";
}

function classify(fileName: string, bytes: Buffer, kind: "image" | "file") {
  const image = sniffImage(bytes);
  if (kind === "image") {
    if (!image || !IMAGE_TYPES.has(image.mimeType)) throw new ChatError(400, "只支持 JPG、PNG、GIF、WebP 图片");
    return image;
  }
  if (image) return image;
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const mimeType = FILE_TYPES[ext];
  if (!mimeType) throw new ChatError(400, "暂不支持这种文件类型");
  return { mimeType, width: null, height: null };
}

/**
 * 上传附件。只有能在这个会话发消息的人可以上传；同一 clientUploadId 重试返回同一条记录。
 * 文件写在私有目录，不经过静态目录，也不能被枚举。
 */
export async function uploadAttachment(
  db: PrismaClient,
  input: { ownerSub: string; conversationId: string; fileName: string; bytes: Buffer; kind: "image" | "file"; clientUploadId?: string | null },
  now = new Date(),
): Promise<Attachment> {
  if (input.bytes.length === 0) throw new ChatError(400, "文件是空的");
  if (input.bytes.length > ATTACHMENT_MAX_BYTES) throw new ChatError(413, "文件不能超过 20MB");
  const clientUploadId = cleanShortText(input.clientUploadId, 80) || null;
  if (clientUploadId) {
    const existing = await db.attachment.findUnique({
      where: { ownerSub_clientUploadId: { ownerSub: input.ownerSub, clientUploadId } },
    });
    if (existing && existing.conversationId === input.conversationId && existing.status !== "DELETED") return existing;
  }
  await withTx(db, async (tx) => {
    const member = await tx.conversationMember.findUnique({
      where: { conversationId_accountSub: { conversationId: input.conversationId, accountSub: input.ownerSub } },
      include: { conversation: true },
    });
    if (!member || member.joinStatus !== "ACTIVE") throw new ChatError(403, "不能在这个会话发送附件");
    if (member.conversation.kind === "DIRECT" && member.conversation.directKey) {
      const access = await directAccess(tx, input.ownerSub, peerFromPairKey(member.conversation.directKey, input.ownerSub));
      if (!access.allowed) throw accessError(access);
    }
  });
  const fileName = safeFileName(input.fileName);
  const detected = classify(fileName, input.bytes, input.kind);
  const id = randomUUID();
  const storageKey = `${now.toISOString().slice(0, 7)}/${id}`;
  const target = path.join(attachmentRoot(), storageKey);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, input.bytes, { mode: 0o600 });
  try {
    return await db.attachment.create({
      data: {
        id,
        ownerSub: input.ownerSub,
        conversationId: input.conversationId,
        storageKey,
        fileName,
        mimeType: detected.mimeType,
        sizeBytes: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        width: detected.width,
        height: detected.height,
        clientUploadId,
        createdAt: now,
      },
    });
  } catch (error) {
    await rm(target, { force: true });
    if (clientUploadId) {
      const existing = await db.attachment.findUnique({
        where: { ownerSub_clientUploadId: { ownerSub: input.ownerSub, clientUploadId } },
      });
      if (existing) return existing;
    }
    throw error;
  }
}

/** 读取附件：必须是会话在席成员；还没发出去的附件只有上传者自己能看。 */
export async function readAttachment(db: PrismaClient, viewerSub: string, attachmentId: string) {
  const attachment = await db.attachment.findUnique({ where: { id: attachmentId } });
  if (!attachment || attachment.status === "DELETED") throw new ChatError(404, "附件不存在");
  if (attachment.status === "UPLOADED" && attachment.ownerSub !== viewerSub) throw new ChatError(404, "附件不存在");
  const member = await db.conversationMember.findUnique({
    where: { conversationId_accountSub: { conversationId: attachment.conversationId, accountSub: viewerSub } },
  });
  if (!member || member.joinStatus !== "ACTIVE") throw new ChatError(404, "附件不存在");
  if (attachment.messageId) {
    const message = await db.message.findUnique({ where: { id: attachment.messageId }, select: { recalledAt: true } });
    if (message?.recalledAt) throw new ChatError(404, "附件已随消息撤回");
  }
  const bytes = await readFile(path.join(attachmentRoot(), attachment.storageKey));
  return { attachment, bytes };
}

export async function pruneStaleAttachments(db: PrismaClient, now = new Date()) {
  const stale = await db.attachment.findMany({
    where: { status: "UPLOADED", createdAt: { lt: new Date(now.getTime() - ORPHAN_TTL_MS) } },
    take: 200,
  });
  for (const row of stale) {
    await rm(path.join(attachmentRoot(), row.storageKey), { force: true });
    await db.attachment.update({ where: { id: row.id }, data: { status: "DELETED" } });
  }
  return stale.length;
}
