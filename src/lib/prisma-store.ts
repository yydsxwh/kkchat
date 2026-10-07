import type { Prisma, PrismaClient } from "@prisma/client";
import { DuplicateRecordError, type ChatMessage, type ChatStore, type Conversation, type Member, type UserProjection } from "./store";
import type { ConversationKind, MessageType, UserDraft } from "./domain";

function isUnique(error: unknown): boolean {
  return typeof error === "object" && error != null && "code" in error && (error as { code?: string }).code === "P2002";
}

function asKind(value: string): ConversationKind {
  if (value === "DIRECT" || value === "GROUP" || value === "CHANNEL") return value;
  return "DIRECT";
}

function asType(value: string): MessageType {
  if (value === "TEXT" || value === "SYSTEM" || value === "ACTION_CARD") return value;
  return "TEXT";
}

export class PrismaChatStore implements ChatStore {
  constructor(private readonly db: PrismaClient) {}

  async upsertUser(input: UserDraft & { id: string }): Promise<UserProjection> {
    const current = await this.db.userProjection.findUnique({ where: { accountSub: input.accountSub } });
    const data = {
      kkNumber: input.kkNumber ?? current?.kkNumber ?? null,
      username: input.username ?? current?.username ?? null,
      displayName: input.displayName || current?.displayName || "用户",
      avatarUrl: input.avatarUrl || current?.avatarUrl || "",
      publicRole: input.publicRole ?? current?.publicRole ?? null,
      profileUpdatedAt: input.profileUpdatedAt,
    };
    const row = current
      ? await this.db.userProjection.update({ where: { accountSub: input.accountSub }, data })
      : await this.db.userProjection.create({ data: { id: input.id, accountSub: input.accountSub, ...data } });
    return this.user(row);
  }

  async findUser(accountSub: string) {
    const row = await this.db.userProjection.findUnique({ where: { accountSub } });
    return row ? this.user(row) : null;
  }

  async findUsers(accountSubs: string[]) {
    const rows = await this.db.userProjection.findMany({ where: { accountSub: { in: accountSubs } } });
    return rows.map((row) => this.user(row));
  }

  async findDirect(directKey: string) {
    const row = await this.db.conversation.findUnique({ where: { directKey } });
    return row ? this.conversation(row) : null;
  }

  async findBusiness(sourceProduct: string, businessType: string, businessRefId: string) {
    const row = await this.db.conversation.findFirst({
      where: { kind: "GROUP", sourceProduct, businessType, businessRefId },
    });
    return row ? this.conversation(row) : null;
  }

  async insertConversation(conversation: Conversation, members: Member[]) {
    try {
      await this.db.$transaction([
        this.db.conversation.create({ data: this.conversationData(conversation) }),
        this.db.conversationMember.createMany({ data: members.map((member) => this.memberData(member)) }),
      ]);
    } catch (error) {
      if (isUnique(error)) throw new DuplicateRecordError();
      throw error;
    }
  }

  async getConversation(id: string) {
    const row = await this.db.conversation.findUnique({ where: { id } });
    return row ? this.conversation(row) : null;
  }

  async touchConversation(id: string, patch: { lastMessageAt: Date; lastMessagePreview: string; updatedAt: Date }) {
    await this.db.conversation.update({ where: { id }, data: patch });
  }

  async getMember(conversationId: string, accountSub: string) {
    const row = await this.db.conversationMember.findUnique({
      where: { conversationId_accountSub: { conversationId, accountSub } },
    });
    return row ? this.member(row) : null;
  }

  async listMembers(conversationId: string) {
    const rows = await this.db.conversationMember.findMany({ where: { conversationId } });
    return rows.map((row) => this.member(row));
  }

  async listMemberships(accountSub: string) {
    const rows = await this.db.conversationMember.findMany({ where: { accountSub } });
    return rows.map((row) => this.member(row));
  }

  async saveMember(member: Member) {
    const data = {
      role: member.role,
      joinStatus: member.joinStatus,
      unreadCount: member.unreadCount,
      lastReadAt: member.lastReadAt,
      lastExternalNotifiedAt: member.lastExternalNotifiedAt,
      muted: member.muted,
      pinned: member.pinned,
    };
    await this.db.conversationMember.upsert({
      where: { id: member.id },
      create: { id: member.id, conversationId: member.conversationId, accountSub: member.accountSub, ...data },
      update: data,
    });
  }

  async findMessageByIdempotency(conversationId: string, senderSub: string, idempotencyKey: string) {
    const row = await this.db.message.findFirst({ where: { conversationId, senderSub, idempotencyKey } });
    return row ? this.message(row) : null;
  }

  async insertMessage(message: ChatMessage) {
    try {
      await this.db.message.create({ data: this.messageData(message) });
    } catch (error) {
      if (isUnique(error)) throw new DuplicateRecordError();
      throw error;
    }
  }

  async listMessages(conversationId: string, limit: number) {
    const rows = await this.db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.reverse().map((row) => this.message(row));
  }

  async getMessage(id: string) {
    const row = await this.db.message.findUnique({ where: { id } });
    return row ? this.message(row) : null;
  }

  async saveMessage(message: ChatMessage) {
    await this.db.message.update({
      where: { id: message.id },
      data: { body: message.body, recalledAt: message.recalledAt, metadataJson: message.metadataJson },
    });
  }

  async addReads(rows: Array<{ id: string; messageId: string; accountSub: string; readAt: Date }>) {
    if (rows.length === 0) return;
    await this.db.messageRead.createMany({ data: rows, skipDuplicates: true });
  }

  async totalUnread(accountSub: string) {
    const grouped = await this.db.conversationMember.aggregate({
      where: { accountSub, joinStatus: "ACTIVE" },
      _sum: { unreadCount: true },
    });
    return grouped._sum.unreadCount || 0;
  }

  private user(row: {
    id: string;
    accountSub: string;
    kkNumber: number | null;
    username: string | null;
    displayName: string;
    avatarUrl: string;
    publicRole: string | null;
    profileUpdatedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }): UserProjection {
    return row;
  }

  private conversation(row: {
    id: string;
    kind: string;
    directKey: string | null;
    title: string;
    avatarUrl: string;
    createdBySub: string;
    sourceProduct: string;
    businessType: string | null;
    businessRefId: string | null;
    lastMessageAt: Date | null;
    lastMessagePreview: string;
    createdAt: Date;
    updatedAt: Date;
  }): Conversation {
    return { ...row, kind: asKind(row.kind) };
  }

  private member(row: {
    id: string;
    conversationId: string;
    accountSub: string;
    role: string;
    joinStatus: string;
    unreadCount: number;
    lastReadAt: Date | null;
    lastExternalNotifiedAt: Date | null;
    muted: boolean;
    pinned: boolean;
  }): Member {
    const role = row.role === "OWNER" || row.role === "ADMIN" ? row.role : "MEMBER";
    const joinStatus = row.joinStatus === "LEFT" ? "LEFT" : "ACTIVE";
    return { ...row, role, joinStatus };
  }

  private message(row: {
    id: string;
    conversationId: string;
    senderSub: string;
    type: string;
    body: string;
    metadataJson: string;
    sourceProduct: string;
    idempotencyKey: string | null;
    recalledAt: Date | null;
    createdAt: Date;
  }): ChatMessage {
    return { ...row, type: asType(row.type) };
  }

  private conversationData(conversation: Conversation): Prisma.ConversationCreateInput {
    return { ...conversation };
  }

  private memberData(member: Member): Prisma.ConversationMemberCreateManyInput {
    return member;
  }

  private messageData(message: ChatMessage): Prisma.MessageCreateInput {
    return {
      id: message.id,
      conversation: { connect: { id: message.conversationId } },
      senderSub: message.senderSub,
      type: message.type,
      body: message.body,
      metadataJson: message.metadataJson,
      sourceProduct: message.sourceProduct,
      idempotencyKey: message.idempotencyKey,
      recalledAt: message.recalledAt,
      createdAt: message.createdAt,
    };
  }
}
