import { randomUUID } from "node:crypto";
import {
  ChatError,
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

export type DirectContact = {
  sub: string;
  displayName: string;
  avatarUrl: string;
  kkNumber: number | null;
  username: string | null;
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
      muted: false,
      pinned: false,
    }));
    await this.store.insertConversation(conversation, members);
    return conversation;
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
  }): Promise<{ message: ChatMessage; conversation: Conversation; duplicate: boolean }> {
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
      if (existing) return { message: existing, conversation, duplicate: true };
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
        if (existing) return { message: existing, conversation, duplicate: true };
      }
      throw error;
    }
    const members = await this.store.listMembers(conversation.id);
    for (const member of members) {
      if (member.accountSub === senderSub || member.joinStatus !== "ACTIVE") continue;
      member.unreadCount += 1;
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
    return { message, conversation: fresh, duplicate: false };
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
