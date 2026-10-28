/**
 * 网页与 App 共用的接口类型。纯类型：不引用 Prisma、Next.js 服务端模块或任何密钥。
 * 与服务端 src/lib 里的视图结构保持一致；改接口时两边一起改。
 */

export type PublicUser = {
  accountSub: string;
  kkNumber: number | null;
  username: string | null;
  displayName: string;
  avatarUrl: string;
};

export type Relation = "friend" | "grant" | "not_friends" | "blocked_by_me";

export type InboxItem = {
  id: string;
  kind: "DIRECT" | "GROUP" | "CHANNEL";
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
  relation: Relation | null;
  canSend: boolean;
};

export type AttachmentView = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
};

export type MessageType = "TEXT" | "IMAGE" | "FILE" | "SYSTEM" | "ACTION_CARD";

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

/** 客户端本地状态：发送中、失败可重试。服务端落库成功后才是 sent。 */
export type LocalMessage = PublicMessage & { localStatus?: "sending" | "failed"; localError?: string };

export type Participant = PublicUser & { lastReadSeq: number; role: string };

export type Thread = {
  conversation: InboxItem;
  peer: PublicUser | null;
  messages: PublicMessage[];
  hasMore: boolean;
  participants: Participant[];
};

export type FriendRequestView = {
  id: string;
  status: string;
  direction: "incoming" | "outgoing";
  peer: PublicUser;
  message: string;
  source: string;
  version: number;
  createdAt: string;
  respondedAt: string | null;
  expiresAt: string;
};

export type FriendView = {
  peer: PublicUser;
  remark: string;
  since: string;
  version: number;
  conversationId: string | null;
};

export type SendRequestResult =
  | { state: "pending"; request: FriendRequestView }
  | { state: "incoming_pending"; request: FriendRequestView }
  | { state: "already_friends"; conversationId: string | null };

export type Relationship = {
  peer: PublicUser;
  isSelf: boolean;
  friend: boolean;
  outgoing: FriendRequestView | null;
  incoming: FriendRequestView | null;
  blockedByMe: boolean;
  canMessage: boolean;
  conversationId: string | null;
  remark: string;
};

export type SearchHit = PublicUser & { relation: "self" | "friend" | "outgoing" | "incoming" | "none" | "blocked_by_me" };

export type PrivacyView = {
  discoverByKkNumber: boolean;
  discoverByUsername: boolean;
  discoverByName: boolean;
  allowFriendRequests: boolean;
  hideNotificationContent: boolean;
};

export type Me = PublicUser & { publicRole: string | null; moderator: boolean; syncSeq: number; session: { kind: "web" | "native"; id?: string } };

export type SyncEventView = { seq: number; kind: string; conversationId: string | null; data: Record<string, unknown>; createdAt: string };

export type SyncPage = { events: SyncEventView[]; nextSeq: number; latestSeq: number; hasMore: boolean; resyncRequired: boolean };

export type InviteView = { token: string; url: string; expiresAt: string };

export type ReportReason = "spam" | "harassment" | "fraud" | "illegal" | "other";

export type AndroidRelease =
  | {
      status: "published";
      version: string;
      versionCode: number;
      downloadUrl: string;
      sizeBytes: number;
      sha256: string;
      minSdk: number | null;
      certSha256: string | null;
      commit: string | null;
      releasedAt: string | null;
      changelog: string;
      minimumUpgradeFrom: string | null;
    }
  | { status: "unavailable"; reason: string };

export type IosRelease =
  | { status: "testflight" | "published"; version: string; url: string; releasedAt: string | null; changelog: string }
  | { status: "unavailable"; reason: string };

export type ReleaseSummary = {
  product: "kkchat";
  web: { status: "published"; url: string };
  android: AndroidRelease;
  ios: IosRelease;
  checkedAt: string;
};

export type NativeSession = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
  accountSub: string;
};
