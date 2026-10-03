import { randomUUID } from "node:crypto";
import {
  ChatError,
  COURSE_GROUP_MEMBER_LIMIT,
  GROUP_MEMBER_LIMIT,
  INBOX_LIMIT,
  MESSAGE_PAGE_SIZE,
  assertUserPublicId,
  buildDirectKey,
  canRecall,
  messagePreview,
  messageReadByPeer,
  normalizeMetadata,
  sanitizeMessageBody,
  type ConversationKind,
  type MessageType,
  type UserDraft,
} from "./domain";
import type { RealtimeBus } from "./realtime";
import { isConversationViewing } from "./viewing";
import { shouldNotifyWechat, wechatCycleKey, wechatExcerpt } from "./wechat-policy";
import {
  DuplicateRecordError,
  type ChatMessage,
  type ChatStore,
  type Conversation,
  type Member,
  type UserProjection,
} from "./store";

export type PublicUser = {
  accountSub: string;
  kkNumber: number | null;
  username: string | null;
  displayName: string;
  avatarUrl: string;
  publicRole: string | null;
};

export type InboxItem = {
  id: string;
  kind: ConversationKind;
  title: string;
  avatarUrl: string;
  peer: PublicUser | null;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unreadCount: number;
  sourceProduct: string;
  businessType: string | null;
  businessRefId: string | null;
};

export type PublicMessage = {
  id: string;
  conversationId: string;
  senderSub: string;
  type: MessageType;
  body: string | null;
  metadata: Record<string, unknown>;
  sourceProduct: string;
  recalledAt: string | null;
  createdAt: string;
  read: boolean;
};

function newId() {
  return randomUUID();
}

function toPublicUser(user: UserProjection | null, accountSub: string): PublicUser {
  return {
    accountSub,
    kkNumber: user?.kkNumber ?? null,
    username: user?.username ?? null,
    displayName: user?.displayName || "用户",
    avatarUrl: user?.avatarUrl || "",
    publicRole: user?.publicRole ?? null,
  };
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // 坏数据按空对象返回，不把解析异常抛给客户端。
  }
  return {};
}

export function toPublicMessage(
  message: ChatMessage,
  members: Array<{ accountSub: string; joinStatus: string; lastReadAt: Date | null }>,
): PublicMessage {
  const recalled = Boolean(message.recalledAt);
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderSub: message.senderSub,
    type: message.type,
    body: recalled ? null : message.body,
    metadata: recalled ? {} : parseMetadata(message.metadataJson),
    sourceProduct: message.sourceProduct,
    recalledAt: message.recalledAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    read: messageReadByPeer(message, members),
  };
}

export class ChatService {
  constructor(
    private readonly store: ChatStore,
    private readonly bus: RealtimeBus,
  ) {}

  async upsertProjection(draft: UserDraft): Promise<UserProjection> {
    return this.store.upsertUser({ ...draft, id: newId() });
  }

  async ensureDirect(input: {
    senderSub: string;
    recipientSub: string;
    sourceProduct: string;
    createdBySub?: string;
    businessType?: string | null;
    businessRefId?: string | null;
    now?: Date;
  }): Promise<Conversation> {
    const senderSub = assertUserPublicId(input.senderSub);
    const recipientSub = assertUserPublicId(input.recipientSub);
    const now = input.now || new Date();
    await this.ensureRow(senderSub, now);
    await this.ensureRow(recipientSub, now);
    const directKey = buildDirectKey(senderSub, recipientSub);
    const existing = await this.store.findDirect(directKey);
    if (existing) return existing;
    const conversation: Conversation = {
      id: newId(),
      kind: "DIRECT",
      directKey,
      title: "",
      avatarUrl: "",
      createdBySub: input.createdBySub ? assertUserPublicId(input.createdBySub) : senderSub,
      sourceProduct: input.sourceProduct || "kkchat",
      businessType: input.businessType || null,
      businessRefId: input.businessRefId || null,
      lastMessageAt: null,
      lastMessagePreview: "",
      createdAt: now,
      updatedAt: now,
    };
    const members: Member[] = [senderSub, recipientSub].map((accountSub, index) => ({
      id: newId(),
      conversationId: conversation.id,
      accountSub,
      role: index === 0 ? "OWNER" : "MEMBER",
      joinStatus: "ACTIVE",
      unreadCount: 0,
      lastReadAt: null,
      lastExternalNotifiedAt: null,
      muted: false,
      pinned: false,
    }));
    try {
      await this.store.insertConversation(conversation, members);
      return conversation;
    } catch (error) {
      if (error instanceof DuplicateRecordError) {
        const again = await this.store.findDirect(directKey);
        if (again) return again;
      }
      throw error;
    }
  }

  async createGroup(input: {
    creatorSub: string;
    title: string;
    memberSubs: string[];
    sourceProduct: string;
    now?: Date;
  }): Promise<Conversation> {
    const creatorSub = assertUserPublicId(input.creatorSub);
    const now = input.now || new Date();
    const title = input.title.trim().slice(0, 80);
    if (!title) throw new ChatError(400, "请填写群名称");
    const unique = [...new Set(input.memberSubs.map((item) => assertUserPublicId(item)))].filter(
      (item) => item !== creatorSub,
    );
    if (unique.length === 0) throw new ChatError(400, "至少再加一位成员");
    if (unique.length + 1 > GROUP_MEMBER_LIMIT) throw new ChatError(400, "群成员过多");
    await this.ensureRow(creatorSub, now);
    for (const accountSub of unique) await this.ensureRow(accountSub, now);
    const conversation: Conversation = {
      id: newId(),
      kind: "GROUP",
      directKey: null,
      title,
      avatarUrl: "",
      createdBySub: creatorSub,
      sourceProduct: input.sourceProduct || "kkchat",
      businessType: null,
      businessRefId: null,
      lastMessageAt: null,
      lastMessagePreview: "",
      createdAt: now,
      updatedAt: now,
    };
    const members: Member[] = [creatorSub, ...unique].map((accountSub, index) => ({
      id: newId(),
      conversationId: conversation.id,
      accountSub,
      role: index === 0 ? "OWNER" : "MEMBER",
      joinStatus: "ACTIVE",
      unreadCount: 0,
      lastReadAt: null,
      lastExternalNotifiedAt: null,
      muted: false,
      pinned: false,
    }));
    await this.store.insertConversation(conversation, members);
    return conversation;
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
    now?: Date;
  }): Promise<Conversation> {
    const creatorSub = assertUserPublicId(input.creatorSub);
    const now = input.now || new Date();
    const title = input.title.trim().slice(0, 80);
    if (!title) throw new ChatError(400, "请填写群名称");
    const businessType = input.businessType.trim();
    const businessRefId = input.businessRefId.trim();
    if (!businessType || !businessRefId) throw new ChatError(400, "缺少课程标识");
    const limit = input.memberLimit ?? (businessType === "course-class" ? COURSE_GROUP_MEMBER_LIMIT : GROUP_MEMBER_LIMIT);
    const unique = [...new Set([creatorSub, ...input.memberSubs.map((item) => assertUserPublicId(item))])];
    if (unique.length > limit) throw new ChatError(400, "群成员过多");
    await this.ensureRow(creatorSub, now);
    for (const accountSub of unique) await this.ensureRow(accountSub, now);
    const existing = await this.store.findBusiness(input.sourceProduct, businessType, businessRefId);
    if (!existing) {
      const conversation: Conversation = {
        id: newId(),
        kind: "GROUP",
        directKey: null,
        title,
        avatarUrl: "",
        createdBySub: creatorSub,
        sourceProduct: input.sourceProduct || "kkchat",
        businessType,
        businessRefId,
        lastMessageAt: null,
        lastMessagePreview: "",
        createdAt: now,
        updatedAt: now,
      };
      const members: Member[] = unique.map((accountSub) => ({
        id: newId(),
        conversationId: conversation.id,
        accountSub,
        role: accountSub === creatorSub ? "OWNER" : "MEMBER",
        joinStatus: "ACTIVE",
        unreadCount: 0,
        lastReadAt: null,
        lastExternalNotifiedAt: null,
        muted: false,
        pinned: false,
      }));
      await this.store.insertConversation(conversation, members);
      return conversation;
    }
    const current = await this.store.listMembers(existing.id);
    const wanted = new Set(unique);
    for (const member of current) {
      const shouldStay = wanted.has(member.accountSub);
      if (shouldStay && member.joinStatus !== "ACTIVE") {
        member.joinStatus = "ACTIVE";
        await this.store.saveMember(member);
      }
      if (!shouldStay && member.joinStatus === "ACTIVE") {
        member.joinStatus = "LEFT";
        await this.store.saveMember(member);
      }
    }
    const known = new Set(current.map((item) => item.accountSub));
    for (const accountSub of unique) {
      if (known.has(accountSub)) continue;
      await this.store.saveMember({
        id: newId(),
        conversationId: existing.id,
        accountSub,
        role: accountSub === creatorSub ? "OWNER" : "MEMBER",
        joinStatus: "ACTIVE",
        unreadCount: 0,
        lastReadAt: null,
        lastExternalNotifiedAt: null,
        muted: false,
        pinned: false,
      });
    }
    return (await this.store.getConversation(existing.id)) || existing;
  }

  async sendMessage(input: {
    senderSub: string;
    conversationId?: string;
    recipientSub?: string;
    type?: MessageType;
    body: string;
    metadata?: unknown;
    sourceProduct: string;
    idempotencyKey?: string | null;
    businessType?: string | null;
    businessRefId?: string | null;
    now?: Date;
  }): Promise<{ message: ChatMessage; conversation: Conversation; duplicate: boolean; externalNotifies: ExternalNotifyPlan[] }> {
    const senderSub = assertUserPublicId(input.senderSub);
    const type = input.type || "TEXT";
    const body = sanitizeMessageBody(input.body);
    const now = input.now || new Date();
    const conversation = input.conversationId
      ? await this.requireConversation(input.conversationId)
      : await this.ensureDirect({
          senderSub,
          recipientSub: input.recipientSub || "",
          sourceProduct: input.sourceProduct,
          businessType: input.businessType,
          businessRefId: input.businessRefId,
          now,
        });
    await this.requireActiveMember(conversation.id, senderSub);
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      if (idempotencyKey.length > 80) throw new ChatError(400, "幂等键过长");
      const existing = await this.store.findMessageByIdempotency(conversation.id, senderSub, idempotencyKey);
      if (existing) return { message: existing, conversation, duplicate: true, externalNotifies: [] };
    }
    const message: ChatMessage = {
      id: newId(),
      conversationId: conversation.id,
      senderSub,
      type,
      body,
      metadataJson: normalizeMetadata(input.metadata),
      sourceProduct: input.sourceProduct || "kkchat",
      idempotencyKey,
      recalledAt: null,
      createdAt: now,
    };
    try {
      await this.store.insertMessage(message);
    } catch (error) {
      if (error instanceof DuplicateRecordError && idempotencyKey) {
        const existing = await this.store.findMessageByIdempotency(conversation.id, senderSub, idempotencyKey);
        if (existing) return { message: existing, conversation, duplicate: true, externalNotifies: [] };
      }
      throw error;
    }
    const members = await this.store.listMembers(conversation.id);
    const announcement = readAnnouncement(message.metadataJson);
    const sender = await this.store.findUser(senderSub);
    const externalNotifies: ExternalNotifyPlan[] = [];
    for (const member of members) {
      if (member.accountSub === senderSub || member.joinStatus !== "ACTIVE") continue;
      const previousUnread = member.unreadCount;
      member.unreadCount += 1;
      const decision = shouldNotifyWechat({
        previousUnread,
        muted: member.muted,
        viewing: isConversationViewing(member.accountSub, conversation.id, now.getTime()),
        active: true,
        lastNotifiedAt: member.lastExternalNotifiedAt,
        lastReadAt: member.lastReadAt,
      });
      if (decision.notify) {
        member.lastExternalNotifiedAt = now;
        externalNotifies.push(buildNotifyPlan({
          conversation,
          member,
          senderName: sender?.displayName || "KKChat",
          body,
          type,
          now,
          announcement,
        }));
      }
      await this.store.saveMember(member);
    }
    await this.store.touchConversation(conversation.id, {
      lastMessageAt: now,
      lastMessagePreview: messagePreview(body, false),
      updatedAt: now,
    });
    const fresh = (await this.store.getConversation(conversation.id)) || conversation;
    this.bus.publish({
      kind: "message",
      conversationId: conversation.id,
      accountSubs: members.filter((item) => item.joinStatus === "ACTIVE").map((item) => item.accountSub),
      data: toPublicMessage(message, members) as unknown as Record<string, unknown>,
    });
    return { message, conversation: fresh, duplicate: false, externalNotifies };
  }

  async listInbox(accountSub: string): Promise<InboxItem[]> {
    const sub = assertUserPublicId(accountSub);
    const memberships = (await this.store.listMemberships(sub)).filter((item) => item.joinStatus === "ACTIVE");
    const items: InboxItem[] = [];
    for (const membership of memberships) {
      const conversation = await this.store.getConversation(membership.conversationId);
      if (!conversation) continue;
      items.push(await this.toInboxItem(conversation, membership));
    }
    items.sort((a, b) => {
      const left = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const right = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return right - left;
    });
    return items.slice(0, INBOX_LIMIT);
  }

  async getThread(accountSub: string, conversationId: string) {
    const sub = assertUserPublicId(accountSub);
    await this.requireActiveMember(conversationId, sub);
    const conversation = await this.requireConversation(conversationId);
    const members = await this.store.listMembers(conversationId);
    const messages = await this.store.listMessages(conversationId, MESSAGE_PAGE_SIZE);
    const membership = members.find((item) => item.accountSub === sub)!;
    return {
      conversation: await this.toInboxItem(conversation, membership),
      messages: messages.map((message) => toPublicMessage(message, members)),
      peer: (await this.toInboxItem(conversation, membership)).peer,
    };
  }

  async markRead(accountSub: string, conversationId: string, now = new Date()) {
    const sub = assertUserPublicId(accountSub);
    const member = await this.requireActiveMember(conversationId, sub);
    member.unreadCount = 0;
    member.lastReadAt = now;
    await this.store.saveMember(member);
    const messages = await this.store.listMessages(conversationId, MESSAGE_PAGE_SIZE);
    await this.store.addReads(
      messages
        .filter((message) => message.senderSub !== sub && !message.recalledAt)
        .map((message) => ({ id: newId(), messageId: message.id, accountSub: sub, readAt: now })),
    );
    const members = await this.store.listMembers(conversationId);
    this.bus.publish({
      kind: "read",
      conversationId,
      accountSubs: members.filter((item) => item.joinStatus === "ACTIVE").map((item) => item.accountSub),
      data: { conversationId, accountSub: sub, lastReadAt: now.toISOString() },
    });
    return { unreadCount: 0, lastReadAt: now.toISOString() };
  }

  async recall(accountSub: string, messageId: string, now = new Date()) {
    const sub = assertUserPublicId(accountSub);
    const message = await this.store.getMessage(messageId);
    if (!message) throw new ChatError(404, "消息不存在");
    await this.requireActiveMember(message.conversationId, sub);
    if (!canRecall(message, sub, now)) throw new ChatError(400, "已超过撤回时间或不能撤回别人的消息");
    message.recalledAt = now;
    await this.store.saveMessage(message);
    const latest = await this.store.listMessages(message.conversationId, 1);
    if (latest[0]?.id === message.id) {
      await this.store.touchConversation(message.conversationId, {
        lastMessageAt: message.createdAt,
        lastMessagePreview: messagePreview(message.body, true),
        updatedAt: now,
      });
    }
    const members = await this.store.listMembers(message.conversationId);
    this.bus.publish({
      kind: "recall",
      conversationId: message.conversationId,
      accountSubs: members.filter((item) => item.joinStatus === "ACTIVE").map((item) => item.accountSub),
      data: toPublicMessage(message, members) as unknown as Record<string, unknown>,
    });
    return toPublicMessage(message, members);
  }

  async totalUnread(accountSub: string) {
    return this.store.totalUnread(assertUserPublicId(accountSub));
  }

  private async ensureRow(accountSub: string, now: Date) {
    const existing = await this.store.findUser(accountSub);
    if (existing) return existing;
    return this.store.upsertUser({
      id: newId(),
      accountSub,
      kkNumber: null,
      username: null,
      displayName: "用户",
      avatarUrl: "",
      publicRole: null,
      profileUpdatedAt: now,
    });
  }

  private async requireConversation(id: string) {
    const conversation = await this.store.getConversation(id);
    if (!conversation) throw new ChatError(404, "会话不存在");
    return conversation;
  }

  private async requireActiveMember(conversationId: string, accountSub: string) {
    const member = await this.store.getMember(conversationId, accountSub);
    if (!member || member.joinStatus !== "ACTIVE") throw new ChatError(403, "不能查看这个会话");
    return member;
  }

  private async toInboxItem(conversation: Conversation, membership: Member): Promise<InboxItem> {
    let peer: PublicUser | null = null;
    if (conversation.kind === "DIRECT" && conversation.directKey) {
      const other = conversation.directKey.split("__").find((item) => item !== membership.accountSub) || "";
      const user = other ? await this.store.findUser(other) : null;
      peer = toPublicUser(user, other);
    }
    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.kind === "DIRECT" ? peer?.displayName || "私聊" : conversation.title,
      avatarUrl: conversation.kind === "DIRECT" ? peer?.avatarUrl || "" : conversation.avatarUrl,
      peer,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: conversation.lastMessagePreview,
      unreadCount: membership.unreadCount,
      sourceProduct: conversation.sourceProduct,
      businessType: conversation.businessType,
      businessRefId: conversation.businessRefId,
    };
  }
}

export function conversationPath(conversationId: string) {
  return `/app/conversations/${encodeURIComponent(conversationId)}`;
}

export type ExternalNotifyPlan = {
  eventType: "KKCHAT_MESSAGE_RECEIVED" | "COURSE_TEACHER_ANNOUNCEMENT";
  recipientSub: string;
  eventId: string;
  dedupeKey: string;
  conversationId: string;
  templateData: Record<string, string>;
};

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
  conversation: Conversation;
  member: Member;
  senderName: string;
  body: string;
  type: MessageType;
  now: Date;
  announcement: { courseName: string } | null;
}): ExternalNotifyPlan {
  const cycle = wechatCycleKey({
    conversationId: input.conversation.id,
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
      conversationId: input.conversation.id,
      templateData: {
        courseName: input.announcement.courseName,
        summary: wechatExcerpt({ type: "TEXT", body: input.body, announcement: true }),
        occurredAt,
      },
    };
  }
  return {
    eventType: "KKCHAT_MESSAGE_RECEIVED",
    recipientSub: input.member.accountSub,
    eventId: cycle,
    dedupeKey: cycle,
    conversationId: input.conversation.id,
    templateData: {
      senderName: input.senderName.trim().slice(0, 20) || "KKChat",
      excerpt: wechatExcerpt({ type: input.type, body: input.body }),
      occurredAt,
    },
  };
}
