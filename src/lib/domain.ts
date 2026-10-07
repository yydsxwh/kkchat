/**
 * 聊天规则。不碰数据库，方便单测，也避免把撤回窗口、长度、身份格式散落在路由里。
 */

export const MESSAGE_MAX_LENGTH = 4000;
export const RECALL_WINDOW_MS = 2 * 60 * 1000;
export const PREVIEW_LENGTH = 80;
export const DIRECTORY_RESULT_LIMIT = 20;
export const GROUP_MEMBER_LIMIT = 50;
/** 课程群由服务端同步在读成员，比随便拉的群更大，但仍有上限。 */
export const COURSE_GROUP_MEMBER_LIMIT = 500;
export const INBOX_LIMIT = 50;
export const MESSAGE_PAGE_SIZE = 100;
export const METADATA_MAX_LENGTH = 4000;

/** 与账号中心 public id 一致：usr_ + 26 位 Crockford base32。 */
const PUBLIC_ID_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

export const CONVERSATION_KINDS = ["DIRECT", "GROUP", "CHANNEL"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const MESSAGE_TYPES = ["TEXT", "SYSTEM", "ACTION_CARD"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export function isUserPublicId(value: string | null | undefined): boolean {
  return PUBLIC_ID_RE.test(String(value || ""));
}

export function assertUserPublicId(value: string): string {
  const sub = value.trim();
  if (!isUserPublicId(sub)) throw new ChatError(400, "账号标识无效");
  return sub;
}

/** 同一对账号永远得到同一个键，和谁先发起、从哪个产品发起无关。 */
export function buildDirectKey(accountSubA: string, accountSubB: string): string {
  const a = assertUserPublicId(accountSubA);
  const b = assertUserPublicId(accountSubB);
  if (a === b) throw new ChatError(400, "不能和自己建立私聊");
  return [a, b].sort().join("__");
}

export function sanitizeMessageBody(raw: string): string {
  const text = String(raw || "").replace(/\u0000/g, "").trim();
  if (!text) throw new ChatError(400, "消息不能为空");
  if (text.length > MESSAGE_MAX_LENGTH) throw new ChatError(400, "消息过长");
  return text;
}

export function messagePreview(body: string, recalled: boolean): string {
  if (recalled) return "已撤回";
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_LENGTH) return flat;
  return `${flat.slice(0, PREVIEW_LENGTH)}…`;
}

export function canRecall(
  message: { senderSub: string; createdAt: Date; recalledAt: Date | null },
  actorSub: string,
  now: Date,
): boolean {
  if (message.senderSub !== actorSub) return false;
  if (message.recalledAt) return false;
  return now.getTime() - message.createdAt.getTime() <= RECALL_WINDOW_MS;
}

export function normalizeMetadata(raw: unknown): string {
  if (raw == null) return "{}";
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ChatError(400, "metadata 必须是对象");
  }
  const json = JSON.stringify(raw);
  if (json.length > METADATA_MAX_LENGTH) throw new ChatError(400, "metadata 过大");
  return json;
}

export type AccountClaims = {
  sub?: string;
  name?: string;
  picture?: string;
  preferred_username?: string;
  username?: string;
  kk_number?: number | string | null;
  role?: string;
  roles?: string[] | string;
};

export type UserDraft = {
  accountSub: string;
  kkNumber: number | null;
  username: string | null;
  displayName: string;
  avatarUrl: string;
  publicRole: string | null;
  profileUpdatedAt: Date;
};

/** 只收下通讯需要的公开字段。邮箱、手机、证件不会进投影。 */
export function projectionFromClaims(claims: AccountClaims, now = new Date()): UserDraft {
  const accountSub = assertUserPublicId(String(claims.sub || ""));
  const kkNumber = parseKkNumber(claims.kk_number);
  const explicitUsername = cleanUsername(claims.username);
  const preferred = cleanUsername(claims.preferred_username);
  const username = explicitUsername || (preferred && !/^\d+$/.test(preferred) ? preferred : null);
  const roles = Array.isArray(claims.roles)
    ? claims.roles.map((item) => String(item).trim()).filter(Boolean)
    : typeof claims.roles === "string"
      ? claims.roles.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  const publicRole = cleanShort(claims.role, 40) || roles[0] || null;
  const displayName =
    cleanShort(claims.name, 80) || username || (kkNumber != null ? String(kkNumber) : "用户");
  return {
    accountSub,
    kkNumber,
    username,
    displayName,
    avatarUrl: cleanShort(claims.picture, 500) || "",
    publicRole,
    profileUpdatedAt: now,
  };
}

function parseKkNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d{0,11}$/.test(value)) return Number(value);
  return null;
}

function cleanUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{3,19}$/.test(text)) return null;
  return text;
}

function cleanShort(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export function isMessageType(value: string): value is MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(value);
}

/** 对方已读：任一其他在席成员的 lastReadAt 不早于这条消息。 */
export function messageReadByPeer(
  message: { senderSub: string; createdAt: Date; recalledAt: Date | null },
  members: Array<{ accountSub: string; joinStatus: string; lastReadAt: Date | null }>,
): boolean {
  if (message.recalledAt) return false;
  return members.some(
    (member) =>
      member.accountSub !== message.senderSub &&
      member.joinStatus === "ACTIVE" &&
      member.lastReadAt != null &&
      member.lastReadAt.getTime() >= message.createdAt.getTime(),
  );
}

export type DirectoryQuery =
  | { kind: "kk"; kkNumber: number }
  | { kind: "username"; username: string }
  | { kind: "name"; name: string };

/** 目录查询只允许三种窄入口，避免空条件扫全表。 */
export function parseDirectoryQuery(input: {
  kkNumber?: string | null;
  username?: string | null;
  q?: string | null;
}): DirectoryQuery {
  const kk = String(input.kkNumber || "").trim();
  if (kk) {
    if (!/^[1-9]\d{0,11}$/.test(kk)) throw new ChatError(400, "KK 号格式不正确");
    return { kind: "kk", kkNumber: Number(kk) };
  }
  const username = String(input.username || "").trim().toLowerCase();
  if (username) {
    if (!/^[a-z][a-z0-9_]{3,19}$/.test(username)) throw new ChatError(400, "账号格式不正确");
    return { kind: "username", username };
  }
  const name = String(input.q || "").trim();
  if (!name) throw new ChatError(400, "请输入 KK 号、账号或姓名");
  if (name.length > 40) throw new ChatError(400, "搜索词过长");
  return { kind: "name", name };
}

export function safeReturnTo(value: string | null | undefined): string {
  const raw = String(value || "").trim();
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw.slice(0, 300);
  return "/app";
}
