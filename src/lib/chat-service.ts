import { randomUUID } from "node:crypto";
import type { Attachment, ConversationMember, Message, PrismaClient, UserProjection } from "@prisma/client";
import { accessError, directAccess, isBlockedEitherWay } from "./access";
import {
  assertUserPublicId,
  buildDirectKey,
  buildPairKey,
  canRecall,
  ChatError,
  cleanShortText,
  COURSE_GROUP_MEMBER_LIMIT,
  GROUP_MEMBER_LIMIT,
  INBOX_LIMIT,
  isMessageType,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  messagePreview,
  messageReadByPeer,
  normalizeMetadata,
  peerFromPairKey,
  sanitizeMessageBody,
  SERVICE_MESSAGE_TYPES,
  USER_MESSAGE_TYPES,
  type ConversationKind,
  type MessageType,
} from "./domain";
import { ensureProjection, toPublicUser, type PublicUser } from "./projection";
import type { RealtimeBus, RealtimeEvent } from "./realtime";
import { appendEvents, publishCommitted, type PendingEvent } from "./sync";
import { isUniqueViolation, withTx, type Tx } from "./tx";
import { isConversationViewing } from "./viewing";
import { shouldNotifyWechat, wechatCycleKey, wechatExcerpt, WECHAT_EXCERPT_FALLBACK } from "./wechat-policy";

export type { PublicUser } from "./projection";

/** 调用方身份只来自已验证的会话或服务凭证，不来自请求体。 */
export type Actor = { kind: "user"; sub: string } | { kind: "service"; product: string };

export type Relation = "friend" | "grant" | "not_friends" | "blocked_by_me";

export type InboxItem = {
  id: string;
  kind: ConversationKind;
  title: string;
  avatarUrl: string;
  peer: PublicUser | null;
  remark: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  lastMessageSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  muted: boolean;
  pinned: boolean;
  sourceProduct: string;
  businessType: string | null;
  businessRefId: string | null;
  /** 仅私聊：当前能否继续发个人消息，以及原因。群聊为 null。 */
  relation: Relation | null;
  canSend: boolean;
};

export type DirectContact = {
  sub: string;
  displayName: string;
  avatarUrl: string;
  kkNumber: number | null;
  username: string | null;
};

export type AttachmentView = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
};

export type PublicMessage = {
  id: string;
  conversationId: string;
  seq: number;
  senderSub: string;
  type: MessageType;
  body: string | null;
  metadata: Record<string, unknown>;
  attachment: AttachmentView | null;
  sourceProduct: string;
  recalledAt: string | null;
  createdAt: string;
  read: boolean;
  clientMessageId: string | null;
};

export type ExternalNotifyPlan = {
  eventType: "KKCHAT_MESSAGE_RECEIVED" | "COURSE_TEACHER_ANNOUNCEMENT";
  recipientSub: string;
  eventId: string;
  dedupeKey: string;
  conversationId: string;
  templateData: Record<string, string>;
};

type MemberCursor = Pick<ConversationMember, "accountSub" | "joinStatus" | "lastReadSeq">;

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // 坏数据按空对象返回，不把解析异常抛给客户端。
  }
  return {};
}

function asType(value: string): MessageType {
  return isMessageType(value) ? value : "TEXT";
}

function asKind(value: string): ConversationKind {
  return value === "GROUP" || value === "CHANNEL" ? value : "DIRECT";
}

export function toPublicMessage(message: Message, members: MemberCursor[]): PublicMessage {
  const recalled = Boolean(message.recalledAt);
  const metadata = recalled ? {} : parseMetadata(message.metadataJson);
  const rawAttachment = metadata.attachment;
  let attachment: AttachmentView | null = null;
  if (!recalled && rawAttachment && typeof rawAttachment === "object") {
    const row = rawAttachment as Record<string, unknown>;
    if (typeof row.id === "string") {
      attachment = {
        id: row.id,
        name: typeof row.name === "string" ? row.name : "file",
        mimeType: typeof row.mimeType === "string" ? row.mimeType : "application/octet-stream",
        size: typeof row.size === "number" ? row.size : 0,
        width: typeof row.width === "number" ? row.width : null,
        height: typeof row.height === "number" ? row.height : null,
      };
    }
  }
  return {
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    senderSub: message.senderSub,
    type: asType(message.type),
    body: recalled ? null : message.body,
    metadata,
    attachment,
    sourceProduct: message.sourceProduct,
    recalledAt: message.recalledAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    read: messageReadByPeer(message, members),
    clientMessageId: message.sourceProduct === "kkchat" ? message.idempotencyKey : null,
  };
}

export class ChatService {
  constructor(
    private readonly db: PrismaClient,
    private readonly bus: RealtimeBus,
  ) {}

  private async commit<T>(fn: (tx: Tx, events: PendingEvent[]) => Promise<T>): Promise<T> {
    let written: RealtimeEvent[] = [];
    const result = await withTx(this.db, async (tx) => {
      const pending: PendingEvent[] = [];
      const value = await fn(tx, pending);
      written = await appendEvents(tx, pending);
      return value;
    });
    publishCommitted(this.bus, written);
    return result;
  }

  /** 普通用户发起私聊：必须已是好友，或有升级前留下的兼容授权。 */
  async openDirectForUser(actorSub: string, peerSub: string, now = new Date()) {
    const sub = assertUserPublicId(actorSub);
    const peer = assertUserPublicId(peerSub);
    buildDirectKey(sub, peer);
    await ensureProjection(this.db, peer, { requireAccount: true, now });
    return this.commit(async (tx, events) => {
      const access = await directAccess(tx, sub, peer);
      if (!access.allowed) throw accessError(access);
      return this.ensureDirectTx(tx, events, { a: sub, b: peer, sourceProduct: "kkchat", createdBySub: sub, now });
    });
  }

  /**
   * 经产品服务凭证建立的业务私聊（站长、教务、课程沟通）。
   * 记一条 BUSINESS 授权，但任一方向拉黑时仍然拒绝。
   */
  async openDirectForService(input: {
    product: string;
    senderSub: string;
    recipientSub: string;
    businessType?: string | null;
    businessRefId?: string | null;
    senderHintName?: string | null;
    recipientHintName?: string | null;
    now?: Date;
  }) {
    const now = input.now || new Date();
    const sender = assertUserPublicId(input.senderSub);
    const recipient = assertUserPublicId(input.recipientSub);
    buildDirectKey(sender, recipient);
    await ensureProjection(this.db, sender, { requireAccount: false, hintName: input.senderHintName, now });
    await ensureProjection(this.db, recipient, { requireAccount: false, hintName: input.recipientHintName, now });
    return this.commit(async (tx, events) => {
      await this.ensureBusinessGrant(tx, {
        a: sender,
        b: recipient,
        product: input.product,
        businessType: input.businessType ?? null,
        businessRefId: input.businessRefId ?? null,
        now,
      });
      return this.ensureDirectTx(tx, events, {
        a: sender,
        b: recipient,
        sourceProduct: input.product,
        createdBySub: sender,
        businessType: input.businessType ?? null,
        businessRefId: input.businessRefId ?? null,
        now,
      });
    });
  }

  private async ensureBusinessGrant(
    tx: Tx,
    input: { a: string; b: string; product: string; businessType: string | null; businessRefId: string | null; now: Date },
  ) {
    if (await isBlockedEitherWay(tx, input.a, input.b)) {
      throw new ChatError(403, "暂时无法给对方发送个人消息");
    }
    const pairKey = buildPairKey(input.a, input.b);
    const friendship = await tx.friendship.findUnique({ where: { pairKey }, select: { status: true } });
    if (friendship?.status === "ACTIVE") return;
    const existing = await tx.directGrant.findFirst({
      where: { pairKey, kind: "BUSINESS", sourceProduct: input.product, revokedAt: null },
      select: { id: true },
    });
    if (existing) return;
    await tx.directGrant.create({
      data: {
        id: randomUUID(),
        pairKey,
        kind: "BUSINESS",
        sourceProduct: input.product,
        businessType: input.businessType,
        businessRefId: input.businessRefId,
        createdAt: input.now,
      },
    });
  }

  /** 找到或创建一对账号唯一的 DIRECT 会话。并发创建时靠 directKey 唯一约束收敛到同一条。 */
  async ensureDirectTx(
    tx: Tx,
    events: PendingEvent[],
    input: {
      a: string;
      b: string;
      sourceProduct: string;
      createdBySub: string;
      businessType?: string | null;
      businessRefId?: string | null;
      now: Date;
    },
  ) {
    const directKey = buildDirectKey(input.a, input.b);
    const existing = await tx.conversation.findUnique({ where: { directKey } });
    if (existing) return { conversation: existing, created: false };
    await ensureProjectionRows(tx, [input.a, input.b], input.now);
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "Conversation" ("id", "kind", "directKey", "title", "avatarUrl", "createdBySub", "sourceProduct",
        "businessType", "businessRefId", "lastMessagePreview", "lastMessageSeq", "createdAt", "updatedAt")
      VALUES (${id}, 'DIRECT', ${directKey}, '', '', ${input.createdBySub}, ${input.sourceProduct || "kkchat"},
        ${input.businessType ?? null}, ${input.businessRefId ?? null}, '', 0, ${input.now}, ${input.now})
      ON CONFLICT ("directKey") DO NOTHING`;
    const conversation = await tx.conversation.findUnique({ where: { directKey } });
    if (!conversation) throw new ChatError(500, "会话创建失败");
    const created = conversation.id === id;
    if (created) {
      await tx.conversationMember.createMany({
        data: [input.a, input.b].map((accountSub) => ({
          id: randomUUID(),
          conversationId: id,
          accountSub,
          role: accountSub === input.createdBySub ? "OWNER" : "MEMBER",
          joinStatus: "ACTIVE",
        })),
        skipDuplicates: true,
      });
      events.push({
        accountSubs: [input.a, input.b],
        kind: "conversation",
        conversationId: id,
        data: { action: "created", conversationId: id },
      });
    }
    return { conversation, created };
  }

  /** 普通用户建群：只能拉自己的好友，不能借群聊绕过好友同意。 */
  async createGroup(input: { creatorSub: string; title: string; memberSubs: string[]; now?: Date }) {
    const creatorSub = assertUserPublicId(input.creatorSub);
    const now = input.now || new Date();
    const title = cleanShortText(input.title, 80);
    if (!title) throw new ChatError(400, "请填写群名称");
    const unique = [...new Set(input.memberSubs.map((item) => assertUserPublicId(item)))].filter((item) => item !== creatorSub);
    if (unique.length === 0) throw new ChatError(400, "至少再加一位成员");
    if (unique.length + 1 > GROUP_MEMBER_LIMIT) throw new ChatError(400, "群成员过多");
    return this.commit(async (tx, events) => {
      for (const member of unique) {
        const access = await directAccess(tx, creatorSub, member);
        if (!access.allowed || access.via !== "friend") throw new ChatError(403, "只能把好友拉进群聊");
      }
      await ensureProjectionRows(tx, [creatorSub, ...unique], now);
      const conversation = await tx.conversation.create({
        data: {
          id: randomUUID(),
          kind: "GROUP",
          title,
          createdBySub: creatorSub,
          sourceProduct: "kkchat",
          createdAt: now,
          members: {
            create: [creatorSub, ...unique].map((accountSub) => ({
              id: randomUUID(),
              accountSub,
              role: accountSub === creatorSub ? "OWNER" : "MEMBER",
              joinStatus: "ACTIVE",
            })),
          },
        },
      });
      events.push({
        accountSubs: [creatorSub, ...unique],
        kind: "conversation",
        conversationId: conversation.id,
        data: { action: "created", conversationId: conversation.id },
      });
      return conversation;
    });
  }

  /**
   * 按产品业务键找到或创建课程群，并同步仍在课的成员。
   * 退课的人标成 LEFT，之后的公告不再发给他们。
   */
  async ensureBusinessGroup(input: {
    creatorSub: string;
    title: string;
    memberSubs: string[];
    sourceProduct: string;
    businessType: string;
    businessRefId: string;
    memberLimit?: number;
    hints?: Map<string, string>;
    now?: Date;
  }) {
    const creatorSub = assertUserPublicId(input.creatorSub);
    const now = input.now || new Date();
    const title = cleanShortText(input.title, 80);
    if (!title) throw new ChatError(400, "请填写群名称");
    const businessType = input.businessType.trim();
    const businessRefId = input.businessRefId.trim();
    if (!businessType || !businessRefId) throw new ChatError(400, "缺少课程标识");
    const limit = input.memberLimit ?? (businessType === "course-class" ? COURSE_GROUP_MEMBER_LIMIT : GROUP_MEMBER_LIMIT);
    const unique = [...new Set([creatorSub, ...input.memberSubs.map((item) => assertUserPublicId(item))])];
    if (unique.length > limit) throw new ChatError(400, "群成员过多");
    for (const sub of unique) {
      await ensureProjection(this.db, sub, { requireAccount: false, hintName: input.hints?.get(sub), now });
    }
    return this.commit(async (tx, events) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`biz:${input.sourceProduct}:${businessType}:${businessRefId}`}, 0))`;
      const existing = await tx.conversation.findFirst({
        where: { kind: "GROUP", sourceProduct: input.sourceProduct, businessType, businessRefId },
      });
      if (!existing) {
        const conversation = await tx.conversation.create({
          data: {
            id: randomUUID(),
            kind: "GROUP",
            title,
            createdBySub: creatorSub,
            sourceProduct: input.sourceProduct || "kkchat",
            businessType,
            businessRefId,
            createdAt: now,
            members: {
              create: unique.map((accountSub) => ({
                id: randomUUID(),
                accountSub,
                role: accountSub === creatorSub ? "OWNER" : "MEMBER",
                joinStatus: "ACTIVE",
              })),
            },
          },
        });
        events.push({
          accountSubs: unique,
          kind: "conversation",
          conversationId: conversation.id,
          data: { action: "created", conversationId: conversation.id },
        });
        return conversation;
      }
      const current = await tx.conversationMember.findMany({ where: { conversationId: existing.id } });
      const wanted = new Set(unique);
      const changed: string[] = [];
      for (const member of current) {
        const shouldStay = wanted.has(member.accountSub);
        if (shouldStay && member.joinStatus !== "ACTIVE") {
          await tx.conversationMember.update({ where: { id: member.id }, data: { joinStatus: "ACTIVE" } });
          changed.push(member.accountSub);
        }
        if (!shouldStay && member.joinStatus === "ACTIVE") {
          await tx.conversationMember.update({ where: { id: member.id }, data: { joinStatus: "LEFT" } });
          changed.push(member.accountSub);
        }
      }
      const known = new Set(current.map((item) => item.accountSub));
      const added = unique.filter((sub) => !known.has(sub));
      if (added.length > 0) {
        await tx.conversationMember.createMany({
          data: added.map((accountSub) => ({
            id: randomUUID(),
            conversationId: existing.id,
            accountSub,
            role: accountSub === creatorSub ? "OWNER" : "MEMBER",
            joinStatus: "ACTIVE",
            lastReadSeq: existing.lastMessageSeq,
          })),
          skipDuplicates: true,
        });
      }
      if (changed.length + added.length > 0) {
        events.push({
          accountSubs: [...changed, ...added],
          kind: "conversation",
          conversationId: existing.id,
          data: { action: "membership", conversationId: existing.id },
        });
      }
      return existing;
    });
  }

  async sendMessage(input: {
    actor: Actor;
    senderSub: string;
    conversationId?: string;
    recipientSub?: string;
    type?: MessageType;
    body: string;
    metadata?: unknown;
    idempotencyKey?: string | null;
    businessType?: string | null;
    businessRefId?: string | null;
    senderHintName?: string | null;
    now?: Date;
  }): Promise<{ message: PublicMessage; conversationId: string; duplicate: boolean; externalNotifies: ExternalNotifyPlan[] }> {
    const senderSub = assertUserPublicId(input.senderSub);
    if (input.actor.kind === "user" && input.actor.sub !== senderSub) throw new ChatError(403, "不能代替别人发消息");
    const type = input.type || "TEXT";
    const allowedTypes: readonly MessageType[] = input.actor.kind === "user" ? USER_MESSAGE_TYPES : SERVICE_MESSAGE_TYPES;
    if (!allowedTypes.includes(type)) throw new ChatError(400, "不支持的消息类型");
    const now = input.now || new Date();
    const sourceProduct = input.actor.kind === "service" ? input.actor.product : "kkchat";
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey && idempotencyKey.length > 80) throw new ChatError(400, "幂等键过长");

    let conversationId = input.conversationId?.trim() || "";
    if (!conversationId) {
      const recipient = assertUserPublicId(input.recipientSub || "");
      const opened =
        input.actor.kind === "service"
          ? await this.openDirectForService({
              product: input.actor.product,
              senderSub,
              recipientSub: recipient,
              businessType: input.businessType,
              businessRefId: input.businessRefId,
              senderHintName: input.senderHintName,
              now,
            })
          : await this.openDirectForUser(senderSub, recipient, now);
      conversationId = opened.conversation.id;
    }

    if (idempotencyKey) {
      const duplicate = await this.findDuplicate(conversationId, senderSub, idempotencyKey);
      if (duplicate) return duplicate;
    }

    let body: string;
    const isAttachment = type === "IMAGE" || type === "FILE";
    if (isAttachment) {
      body = cleanShortText(input.body, 200);
    } else {
      body = sanitizeMessageBody(input.body);
    }
    const requestedMetadata = isAttachment ? null : normalizeMetadata(input.metadata);
    const attachmentId = isAttachment ? readAttachmentId(input.metadata) : null;
    if (isAttachment && !attachmentId) throw new ChatError(400, "缺少附件");

    try {
      return await this.commit(async (tx, events) => {
        const locked = await tx.$queryRaw<Array<{ lastMessageSeq: number; kind: string; directKey: string | null }>>`
          UPDATE "Conversation" SET "lastMessageSeq" = "lastMessageSeq" + 1, "updatedAt" = ${now}
          WHERE "id" = ${conversationId}
          RETURNING "lastMessageSeq", "kind", "directKey"`;
        const row = locked[0];
        if (!row) throw new ChatError(404, "会话不存在");
        const seq = row.lastMessageSeq;
        const sender = await tx.conversationMember.findUnique({
          where: { conversationId_accountSub: { conversationId, accountSub: senderSub } },
        });
        if (!sender || sender.joinStatus !== "ACTIVE") throw new ChatError(403, "不能在这个会话发消息");

        if (row.kind === "DIRECT" && row.directKey) {
          const peer = peerFromPairKey(row.directKey, senderSub);
          const access = await directAccess(tx, senderSub, peer);
          if (!access.allowed) {
            if (input.actor.kind === "service" && access.reason === "not_friends") {
              await this.ensureBusinessGrant(tx, {
                a: senderSub,
                b: peer,
                product: input.actor.product,
                businessType: input.businessType ?? null,
                businessRefId: input.businessRefId ?? null,
                now,
              });
            } else {
              throw accessError(access);
            }
          }
        }

        let metadataJson = requestedMetadata || "{}";
        let finalBody = body;
        if (isAttachment) {
          const attachment = await this.claimAttachment(tx, { attachmentId: attachmentId!, senderSub, conversationId, type, now });
          metadataJson = JSON.stringify({ attachment: attachmentMetadata(attachment) });
          finalBody = body || attachment.fileName;
        }

        const message = await tx.message.create({
          data: {
            id: randomUUID(),
            conversationId,
            seq,
            senderSub,
            type,
            body: finalBody,
            metadataJson,
            sourceProduct,
            idempotencyKey,
            createdAt: now,
          },
        });
        if (isAttachment) {
          await tx.attachment.update({ where: { id: attachmentId! }, data: { messageId: message.id } });
        }

        await tx.conversationMember.updateMany({
          where: { conversationId, accountSub: { not: senderSub }, joinStatus: "ACTIVE" },
          data: { unreadCount: { increment: 1 } },
        });
        // 自己发的消息视为已读到这里。
        await tx.conversationMember.update({
          where: { id: sender.id },
          data: { lastReadSeq: seq, unreadCount: 0, lastReadAt: now },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: now, lastMessagePreview: messagePreview(finalBody, false, type) },
        });

        const members = await tx.conversationMember.findMany({ where: { conversationId } });
        const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
        const externalNotifies = await this.planNotifications(tx, {
          conversation,
          members,
          senderSub,
          body: finalBody,
          type,
          metadataJson,
          now,
        });
        const publicMessage = toPublicMessage(message, members);
        events.push({
          accountSubs: members.filter((item) => item.joinStatus === "ACTIVE").map((item) => item.accountSub),
          kind: "message",
          conversationId,
          data: publicMessage as unknown as Record<string, unknown>,
        });
        return { message: publicMessage, conversationId, duplicate: false, externalNotifies };
      });
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error)) {
        const duplicate = await this.findDuplicate(conversationId, senderSub, idempotencyKey);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  private async findDuplicate(conversationId: string, senderSub: string, idempotencyKey: string) {
    const existing = await this.db.message.findFirst({ where: { conversationId, senderSub, idempotencyKey } });
    if (!existing) return null;
    const members = await this.db.conversationMember.findMany({ where: { conversationId } });
    return {
      message: toPublicMessage(existing, members),
      conversationId,
      duplicate: true,
      externalNotifies: [] as ExternalNotifyPlan[],
    };
  }

  private async claimAttachment(
    tx: Tx,
    input: { attachmentId: string; senderSub: string; conversationId: string; type: MessageType; now: Date },
  ): Promise<Attachment> {
    const attachment = await tx.attachment.findUnique({ where: { id: input.attachmentId } });
    if (!attachment || attachment.ownerSub !== input.senderSub || attachment.conversationId !== input.conversationId) {
      throw new ChatError(404, "附件不存在");
    }
    if (attachment.status !== "UPLOADED") throw new ChatError(409, "附件已经发送过");
    if (input.type === "IMAGE" && !attachment.mimeType.startsWith("image/")) throw new ChatError(400, "这个附件不是图片");
    const claimed = await tx.attachment.updateMany({
      where: { id: attachment.id, status: "UPLOADED" },
      data: { status: "ATTACHED", attachedAt: input.now },
    });
    if (claimed.count !== 1) throw new ChatError(409, "附件已经发送过");
    return attachment;
  }

  private async planNotifications(
    tx: Tx,
    input: {
      conversation: { id: string };
      members: ConversationMember[];
      senderSub: string;
      body: string;
      type: MessageType;
      metadataJson: string;
      now: Date;
    },
  ): Promise<ExternalNotifyPlan[]> {
    const announcement = readAnnouncement(input.metadataJson);
    const sender = await tx.userProjection.findUnique({ where: { accountSub: input.senderSub } });
    const candidates = input.members.filter((member) => member.accountSub !== input.senderSub && member.joinStatus === "ACTIVE");
    const privacy = await tx.privacySetting.findMany({
      where: { accountSub: { in: candidates.map((item) => item.accountSub) }, hideNotificationContent: true },
      select: { accountSub: true },
    });
    const hidden = new Set(privacy.map((item) => item.accountSub));
    const plans: ExternalNotifyPlan[] = [];
    const notifiedIds: string[] = [];
    for (const member of candidates) {
      const decision = shouldNotifyWechat({
        previousUnread: Math.max(0, member.unreadCount - 1),
        muted: member.muted,
        viewing: isConversationViewing(member.accountSub, input.conversation.id, input.now.getTime()),
        active: true,
        lastNotifiedAt: member.lastExternalNotifiedAt,
        lastReadAt: member.lastReadAt,
      });
      if (!decision.notify) continue;
      notifiedIds.push(member.id);
      plans.push(
        buildNotifyPlan({
          conversationId: input.conversation.id,
          member,
          senderName: sender?.displayName || "KKChat",
          body: input.body,
          type: input.type,
          now: input.now,
          announcement,
          hideContent: hidden.has(member.accountSub),
        }),
      );
    }
    if (notifiedIds.length > 0) {
      await tx.conversationMember.updateMany({ where: { id: { in: notifiedIds } }, data: { lastExternalNotifiedAt: input.now } });
    }
    return plans;
  }

  async listInbox(accountSub: string): Promise<InboxItem[]> {
    const sub = assertUserPublicId(accountSub);
    const memberships = await this.db.conversationMember.findMany({
      where: { accountSub: sub, joinStatus: "ACTIVE" },
      include: { conversation: true },
    });
    const directPeers = memberships
      .filter((item) => item.conversation.kind === "DIRECT" && item.conversation.directKey)
      .map((item) => peerFromPairKey(item.conversation.directKey!, sub));
    const context = await this.relationContext(sub, directPeers);
    const items = memberships.map((membership) => this.toInboxItem(sub, membership, membership.conversation, context));
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const left = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const right = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return right - left;
    });
    return items.slice(0, INBOX_LIMIT);
  }

  async getConversationItem(accountSub: string, conversationId: string): Promise<InboxItem> {
    const sub = assertUserPublicId(accountSub);
    const membership = await this.requireActiveMember(conversationId, sub);
    const conversation = await this.requireConversation(conversationId);
    const peers = conversation.kind === "DIRECT" && conversation.directKey ? [peerFromPairKey(conversation.directKey, sub)] : [];
    const context = await this.relationContext(sub, peers);
    return this.toInboxItem(sub, membership, conversation, context);
  }

  async getThread(accountSub: string, conversationId: string, options: { beforeSeq?: number | null; limit?: number } = {}) {
    const sub = assertUserPublicId(accountSub);
    const conversation = await this.getConversationItem(sub, conversationId);
    const page = await this.listMessages(sub, conversationId, { beforeSeq: options.beforeSeq, limit: options.limit });
    const members = await this.db.conversationMember.findMany({
      where: { conversationId, joinStatus: "ACTIVE" },
      include: { user: true },
      take: COURSE_GROUP_MEMBER_LIMIT,
    });
    return {
      conversation,
      peer: conversation.peer,
      messages: page.messages,
      hasMore: page.hasMore,
      participants: members.map((member) => ({
        ...toPublicUser(member.user, member.accountSub),
        lastReadSeq: member.lastReadSeq,
        role: member.role,
      })),
    };
  }

  async listMessages(
    accountSub: string,
    conversationId: string,
    options: { beforeSeq?: number | null; afterSeq?: number | null; limit?: number } = {},
  ): Promise<{ messages: PublicMessage[]; hasMore: boolean }> {
    const sub = assertUserPublicId(accountSub);
    await this.requireActiveMember(conversationId, sub);
    const limit = Math.min(Math.max(options.limit || MESSAGE_PAGE_SIZE, 1), MESSAGE_PAGE_MAX);
    const members = await this.db.conversationMember.findMany({ where: { conversationId } });
    if (options.afterSeq != null) {
      const rows = await this.db.message.findMany({
        where: { conversationId, seq: { gt: options.afterSeq } },
        orderBy: { seq: "asc" },
        take: limit + 1,
      });
      return { messages: rows.slice(0, limit).map((row) => toPublicMessage(row, members)), hasMore: rows.length > limit };
    }
    const rows = await this.db.message.findMany({
      where: { conversationId, ...(options.beforeSeq != null ? { seq: { lt: options.beforeSeq } } : {}) },
      orderBy: { seq: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit).reverse();
    return { messages: page.map((row) => toPublicMessage(row, members)), hasMore: rows.length > limit };
  }

  /**
   * 已读游标只前进。和发消息共用会话行锁（FOR SHARE 等待发送事务提交），
   * 所以重新统计未读时一定能看到刚提交的新消息，旧的已读请求不会把新未读清零。
   */
  async markRead(accountSub: string, conversationId: string, upToSeq?: number | null, now = new Date()) {
    const sub = assertUserPublicId(accountSub);
    return this.commit(async (tx, events) => {
      const locked = await tx.$queryRaw<Array<{ lastMessageSeq: number }>>`
        SELECT "lastMessageSeq" FROM "Conversation" WHERE "id" = ${conversationId} FOR SHARE`;
      if (!locked[0]) throw new ChatError(404, "会话不存在");
      const member = await tx.conversationMember.findUnique({
        where: { conversationId_accountSub: { conversationId, accountSub: sub } },
      });
      if (!member || member.joinStatus !== "ACTIVE") throw new ChatError(403, "不能查看这个会话");
      const latest = locked[0].lastMessageSeq;
      const target = Math.min(upToSeq != null && Number.isInteger(upToSeq) && upToSeq >= 0 ? upToSeq : latest, latest);
      const rows = await tx.$queryRaw<Array<{ lastReadSeq: number; unreadCount: number }>>`
        UPDATE "ConversationMember" AS cm
        SET "lastReadSeq" = GREATEST(cm."lastReadSeq", ${target}),
            "lastReadAt" = CASE WHEN ${target} > cm."lastReadSeq" THEN ${now} ELSE cm."lastReadAt" END,
            "unreadCount" = (
              SELECT COUNT(*)::int FROM "Message" m
              WHERE m."conversationId" = ${conversationId}
                AND m."seq" > GREATEST(cm."lastReadSeq", ${target})
                AND m."senderSub" <> ${sub}
                AND m."recalledAt" IS NULL
            ),
            "updatedAt" = ${now}
        WHERE cm."id" = ${member.id}
        RETURNING "lastReadSeq", "unreadCount"`;
      const result = rows[0];
      if (result.lastReadSeq > member.lastReadSeq) {
        const active = await tx.conversationMember.findMany({
          where: { conversationId, joinStatus: "ACTIVE" },
          select: { accountSub: true },
        });
        events.push({
          accountSubs: active.map((item) => item.accountSub),
          kind: "read",
          conversationId,
          data: { conversationId, accountSub: sub, lastReadSeq: result.lastReadSeq, unreadCount: result.unreadCount },
        });
      }
      return { unreadCount: result.unreadCount, lastReadSeq: result.lastReadSeq, lastReadAt: now.toISOString() };
    });
  }

  async recall(accountSub: string, messageId: string, now = new Date()) {
    const sub = assertUserPublicId(accountSub);
    return this.commit(async (tx, events) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Message" WHERE "id" = ${messageId} FOR UPDATE`;
      if (!locked[0]) throw new ChatError(404, "消息不存在");
      const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
      const member = await tx.conversationMember.findUnique({
        where: { conversationId_accountSub: { conversationId: message.conversationId, accountSub: sub } },
      });
      if (!member || member.joinStatus !== "ACTIVE") throw new ChatError(403, "不能查看这个会话");
      if (!canRecall(message, sub, now)) throw new ChatError(400, "已超过撤回时间或不能撤回别人的消息");
      const updated = await tx.message.update({ where: { id: message.id }, data: { recalledAt: now } });
      const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: message.conversationId } });
      if (conversation.lastMessageSeq === message.seq) {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { lastMessagePreview: messagePreview(message.body, true) },
        });
      }
      await tx.conversationMember.updateMany({
        where: {
          conversationId: message.conversationId,
          accountSub: { not: sub },
          joinStatus: "ACTIVE",
          lastReadSeq: { lt: message.seq },
          unreadCount: { gt: 0 },
        },
        data: { unreadCount: { decrement: 1 } },
      });
      const members = await tx.conversationMember.findMany({ where: { conversationId: message.conversationId } });
      const publicMessage = toPublicMessage(updated, members);
      events.push({
        accountSubs: members.filter((item) => item.joinStatus === "ACTIVE").map((item) => item.accountSub),
        kind: "recall",
        conversationId: message.conversationId,
        data: publicMessage as unknown as Record<string, unknown>,
      });
      return publicMessage;
    });
  }

  async setConversationPrefs(accountSub: string, conversationId: string, prefs: { pinned?: boolean; muted?: boolean }) {
    const sub = assertUserPublicId(accountSub);
    return this.commit(async (tx, events) => {
      const member = await tx.conversationMember.findUnique({
        where: { conversationId_accountSub: { conversationId, accountSub: sub } },
      });
      if (!member || member.joinStatus !== "ACTIVE") throw new ChatError(403, "不能查看这个会话");
      const data: { pinned?: boolean; muted?: boolean } = {};
      if (typeof prefs.pinned === "boolean") data.pinned = prefs.pinned;
      if (typeof prefs.muted === "boolean") data.muted = prefs.muted;
      const updated = await tx.conversationMember.update({ where: { id: member.id }, data });
      events.push({
        accountSubs: [sub],
        kind: "conversation",
        conversationId,
        data: { action: "prefs", conversationId, pinned: updated.pinned, muted: updated.muted },
      });
      return { pinned: updated.pinned, muted: updated.muted };
    });
  }

  async totalUnread(accountSub: string) {
    const grouped = await this.db.conversationMember.aggregate({
      where: { accountSub: assertUserPublicId(accountSub), joinStatus: "ACTIVE" },
      _sum: { unreadCount: true },
    });
    return grouped._sum.unreadCount || 0;
  }

  /** 最近私聊对象。这是快捷联系人，不是好友关系，也不能当作日事授权。 */
  async listDirectContacts(accountSub: string): Promise<DirectContact[]> {
    const inbox = await this.listInbox(accountSub);
    const seen = new Set<string>();
    const contacts: DirectContact[] = [];
    for (const item of inbox) {
      if (item.kind !== "DIRECT" || !item.peer) continue;
      if (seen.has(item.peer.accountSub)) continue;
      seen.add(item.peer.accountSub);
      contacts.push({
        sub: item.peer.accountSub,
        displayName: item.peer.displayName,
        avatarUrl: item.peer.avatarUrl,
        kkNumber: item.peer.kkNumber,
        username: item.peer.username,
      });
    }
    return contacts;
  }

  private async relationContext(sub: string, peers: string[]) {
    const unique = [...new Set(peers)];
    const pairKeys = unique.map((peer) => buildPairKey(sub, peer));
    const [users, friendships, grants, blocks, notes] = await Promise.all([
      this.db.userProjection.findMany({ where: { accountSub: { in: unique } } }),
      this.db.friendship.findMany({ where: { pairKey: { in: pairKeys }, status: "ACTIVE" }, select: { pairKey: true } }),
      this.db.directGrant.findMany({ where: { pairKey: { in: pairKeys }, revokedAt: null }, select: { pairKey: true } }),
      this.db.userBlock.findMany({
        where: {
          OR: [
            { blockerSub: sub, blockedSub: { in: unique } },
            { blockedSub: sub, blockerSub: { in: unique } },
          ],
        },
        select: { blockerSub: true, blockedSub: true },
      }),
      this.db.contactNote.findMany({ where: { ownerSub: sub, targetSub: { in: unique } } }),
    ]);
    return {
      users: new Map(users.map((user) => [user.accountSub, user])),
      friends: new Set(friendships.map((row) => row.pairKey)),
      grants: new Set(grants.map((row) => row.pairKey)),
      blockedByMe: new Set(blocks.filter((row) => row.blockerSub === sub).map((row) => row.blockedSub)),
      blockedMe: new Set(blocks.filter((row) => row.blockedSub === sub).map((row) => row.blockerSub)),
      remarks: new Map(notes.map((note) => [note.targetSub, note.remark])),
    };
  }

  private toInboxItem(
    sub: string,
    membership: ConversationMember,
    conversation: {
      id: string;
      kind: string;
      directKey: string | null;
      title: string;
      avatarUrl: string;
      lastMessageAt: Date | null;
      lastMessagePreview: string;
      lastMessageSeq: number;
      sourceProduct: string;
      businessType: string | null;
      businessRefId: string | null;
    },
    context: Awaited<ReturnType<ChatService["relationContext"]>>,
  ): InboxItem {
    let peer: PublicUser | null = null;
    let relation: Relation | null = null;
    let remark = "";
    if (conversation.kind === "DIRECT" && conversation.directKey) {
      const other = peerFromPairKey(conversation.directKey, sub);
      peer = toPublicUser(context.users.get(other) as UserProjection | undefined ?? null, other);
      remark = context.remarks.get(other) || "";
      const pairKey = buildPairKey(sub, other);
      if (context.blockedByMe.has(other)) relation = "blocked_by_me";
      else if (context.blockedMe.has(other)) relation = "not_friends";
      else if (context.friends.has(pairKey)) relation = "friend";
      else if (context.grants.has(pairKey)) relation = "grant";
      else relation = "not_friends";
    }
    const kind = asKind(conversation.kind);
    return {
      id: conversation.id,
      kind,
      title: kind === "DIRECT" ? remark || peer?.displayName || "私聊" : conversation.title,
      avatarUrl: kind === "DIRECT" ? peer?.avatarUrl || "" : conversation.avatarUrl,
      peer,
      remark,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: conversation.lastMessagePreview,
      lastMessageSeq: conversation.lastMessageSeq,
      lastReadSeq: membership.lastReadSeq,
      unreadCount: membership.unreadCount,
      muted: membership.muted,
      pinned: membership.pinned,
      sourceProduct: conversation.sourceProduct,
      businessType: conversation.businessType,
      businessRefId: conversation.businessRefId,
      relation,
      canSend: relation === null || relation === "friend" || relation === "grant",
    };
  }

  private async requireConversation(id: string) {
    const conversation = await this.db.conversation.findUnique({ where: { id } });
    if (!conversation) throw new ChatError(404, "会话不存在");
    return conversation;
  }

  private async requireActiveMember(conversationId: string, accountSub: string) {
    const member = await this.db.conversationMember.findUnique({
      where: { conversationId_accountSub: { conversationId, accountSub } },
    });
    if (!member || member.joinStatus !== "ACTIVE") throw new ChatError(403, "不能查看这个会话");
    return member;
  }
}

/** 外键要求成员先有投影行。只补占位，不覆盖已有资料。 */
export async function ensureProjectionRows(tx: Tx, subs: string[], now: Date) {
  const unique = [...new Set(subs)].sort();
  if (unique.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO "UserProjection" ("id", "accountSub", "displayName", "avatarUrl", "profileSource", "profileUpdatedAt", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, s, '用户', '', 'HINT', ${now}, ${now}, ${now} FROM unnest(${unique}::text[]) AS s
    ON CONFLICT ("accountSub") DO NOTHING`;
}

function readAttachmentId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).attachmentId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function attachmentMetadata(attachment: Attachment): AttachmentView {
  return {
    id: attachment.id,
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
  };
}

export function conversationPath(conversationId: string) {
  return `/app/conversations/${encodeURIComponent(conversationId)}`;
}

function readAnnouncement(metadataJson: string): { courseName: string } | null {
  try {
    const parsed = JSON.parse(metadataJson) as { notice?: unknown; courseName?: unknown };
    if (parsed?.notice !== "course-announcement") return null;
    const courseName = typeof parsed.courseName === "string" ? parsed.courseName.trim().slice(0, 20) : "";
    return { courseName: courseName || "课程" };
  } catch {
    return null;
  }
}

function buildNotifyPlan(input: {
  conversationId: string;
  member: ConversationMember;
  senderName: string;
  body: string;
  type: MessageType;
  now: Date;
  announcement: { courseName: string } | null;
  hideContent: boolean;
}): ExternalNotifyPlan {
  const cycle = wechatCycleKey({
    conversationId: input.conversationId,
    recipientSub: input.member.accountSub,
    lastReadAt: input.member.lastReadAt,
  });
  const occurredAt = input.now.toISOString().slice(0, 16).replace("T", " ");
  if (input.announcement) {
    return {
      eventType: "COURSE_TEACHER_ANNOUNCEMENT",
      recipientSub: input.member.accountSub,
      eventId: cycle,
      dedupeKey: cycle,
      conversationId: input.conversationId,
      templateData: {
        courseName: input.announcement.courseName,
        summary: input.hideContent
          ? "请查看课程通知"
          : wechatExcerpt({ type: "TEXT", body: input.body, announcement: true }),
        occurredAt,
      },
    };
  }
  return {
    eventType: "KKCHAT_MESSAGE_RECEIVED",
    recipientSub: input.member.accountSub,
    eventId: cycle,
    dedupeKey: cycle,
    conversationId: input.conversationId,
    templateData: {
      senderName: input.senderName.trim().slice(0, 20) || "KKChat",
      excerpt: input.hideContent ? WECHAT_EXCERPT_FALLBACK : wechatExcerpt({ type: input.type, body: input.body }),
      occurredAt,
    },
  };
}
