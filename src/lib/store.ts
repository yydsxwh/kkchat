import type { ConversationKind, MessageType, UserDraft } from "./domain";

export type UserProjection = UserDraft & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Conversation = {
  id: string;
  kind: ConversationKind;
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
};

export type Member = {
  id: string;
  conversationId: string;
  accountSub: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  joinStatus: "ACTIVE" | "LEFT";
  unreadCount: number;
  lastReadAt: Date | null;
  lastExternalNotifiedAt: Date | null;
  muted: boolean;
  pinned: boolean;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  senderSub: string;
  type: MessageType;
  body: string;
  metadataJson: string;
  sourceProduct: string;
  idempotencyKey: string | null;
  recalledAt: Date | null;
  createdAt: Date;
};

export class DuplicateRecordError extends Error {
  constructor() {
    super("duplicate");
    this.name = "DuplicateRecordError";
  }
}

export interface ChatStore {
  upsertUser(input: UserDraft & { id: string }): Promise<UserProjection>;
  findUser(accountSub: string): Promise<UserProjection | null>;
  findUsers(accountSubs: string[]): Promise<UserProjection[]>;
  findDirect(directKey: string): Promise<Conversation | null>;
  findBusiness(sourceProduct: string, businessType: string, businessRefId: string): Promise<Conversation | null>;
  insertConversation(conversation: Conversation, members: Member[]): Promise<void>;
  getConversation(id: string): Promise<Conversation | null>;
  touchConversation(
    id: string,
    patch: { lastMessageAt: Date; lastMessagePreview: string; updatedAt: Date },
  ): Promise<void>;
  getMember(conversationId: string, accountSub: string): Promise<Member | null>;
  listMembers(conversationId: string): Promise<Member[]>;
  listMemberships(accountSub: string): Promise<Member[]>;
  saveMember(member: Member): Promise<void>;
  findMessageByIdempotency(
    conversationId: string,
    senderSub: string,
    idempotencyKey: string,
  ): Promise<ChatMessage | null>;
  insertMessage(message: ChatMessage): Promise<void>;
  listMessages(conversationId: string, limit: number): Promise<ChatMessage[]>;
  getMessage(id: string): Promise<ChatMessage | null>;
  saveMessage(message: ChatMessage): Promise<void>;
  addReads(rows: Array<{ id: string; messageId: string; accountSub: string; readAt: Date }>): Promise<void>;
  totalUnread(accountSub: string): Promise<number>;
}

export class MemoryChatStore implements ChatStore {
  users = new Map<string, UserProjection>();
  conversations = new Map<string, Conversation>();
  members: Member[] = [];
  messages: ChatMessage[] = [];
  reads: Array<{ id: string; messageId: string; accountSub: string; readAt: Date }> = [];

  async upsertUser(input: UserDraft & { id: string }): Promise<UserProjection> {
    const current = this.users.get(input.accountSub);
    const next: UserProjection = {
      id: current?.id || input.id,
      accountSub: input.accountSub,
      kkNumber: input.kkNumber ?? current?.kkNumber ?? null,
      username: input.username ?? current?.username ?? null,
      displayName: input.displayName || current?.displayName || "用户",
      avatarUrl: input.avatarUrl || current?.avatarUrl || "",
      publicRole: input.publicRole ?? current?.publicRole ?? null,
      profileUpdatedAt: input.profileUpdatedAt,
      createdAt: current?.createdAt || input.profileUpdatedAt,
      updatedAt: input.profileUpdatedAt,
    };
    this.users.set(next.accountSub, next);
    return next;
  }

  async findUser(accountSub: string) {
    return this.users.get(accountSub) || null;
  }

  async findUsers(accountSubs: string[]) {
    return accountSubs.flatMap((sub) => {
      const user = this.users.get(sub);
      return user ? [user] : [];
    });
  }

  async findDirect(directKey: string) {
    for (const conversation of this.conversations.values()) {
      if (conversation.directKey === directKey) return conversation;
    }
    return null;
  }

  async findBusiness(sourceProduct: string, businessType: string, businessRefId: string) {
    for (const conversation of this.conversations.values()) {
      if (
        conversation.kind === "GROUP" &&
        conversation.sourceProduct === sourceProduct &&
        conversation.businessType === businessType &&
        conversation.businessRefId === businessRefId
      ) {
        return conversation;
      }
    }
    return null;
  }

  async insertConversation(conversation: Conversation, members: Member[]) {
    if (conversation.directKey) {
      const existing = await this.findDirect(conversation.directKey);
      if (existing) throw new DuplicateRecordError();
    }
    this.conversations.set(conversation.id, conversation);
    for (const member of members) {
      if (this.members.some((item) => item.conversationId === member.conversationId && item.accountSub === member.accountSub)) {
        throw new DuplicateRecordError();
      }
      this.members.push(member);
    }
  }

  async getConversation(id: string) {
    return this.conversations.get(id) || null;
  }

  async touchConversation(id: string, patch: { lastMessageAt: Date; lastMessagePreview: string; updatedAt: Date }) {
    const current = this.conversations.get(id);
    if (!current) return;
    this.conversations.set(id, { ...current, ...patch });
  }

  async getMember(conversationId: string, accountSub: string) {
    return this.members.find((item) => item.conversationId === conversationId && item.accountSub === accountSub) || null;
  }

  async listMembers(conversationId: string) {
    return this.members.filter((item) => item.conversationId === conversationId);
  }

  async listMemberships(accountSub: string) {
    return this.members.filter((item) => item.accountSub === accountSub);
  }

  async saveMember(member: Member) {
    const index = this.members.findIndex((item) => item.id === member.id);
    if (index < 0) this.members.push(member);
    else this.members[index] = member;
  }

  async findMessageByIdempotency(conversationId: string, senderSub: string, idempotencyKey: string) {
    return (
      this.messages.find(
        (item) =>
          item.conversationId === conversationId &&
          item.senderSub === senderSub &&
          item.idempotencyKey === idempotencyKey,
      ) || null
    );
  }

  async insertMessage(message: ChatMessage) {
    if (message.idempotencyKey) {
      const existing = await this.findMessageByIdempotency(
        message.conversationId,
        message.senderSub,
        message.idempotencyKey,
      );
      if (existing) throw new DuplicateRecordError();
    }
    this.messages.push(message);
  }

  async listMessages(conversationId: string, limit: number) {
    return this.messages
      .filter((item) => item.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(-limit);
  }

  async getMessage(id: string) {
    return this.messages.find((item) => item.id === id) || null;
  }

  async saveMessage(message: ChatMessage) {
    const index = this.messages.findIndex((item) => item.id === message.id);
    if (index >= 0) this.messages[index] = message;
  }

  async addReads(rows: Array<{ id: string; messageId: string; accountSub: string; readAt: Date }>) {
    for (const row of rows) {
      if (this.reads.some((item) => item.messageId === row.messageId && item.accountSub === row.accountSub)) continue;
      this.reads.push(row);
    }
  }

  async totalUnread(accountSub: string) {
    return this.members
      .filter((item) => item.accountSub === accountSub && item.joinStatus === "ACTIVE")
      .reduce((sum, item) => sum + item.unreadCount, 0);
  }
}
