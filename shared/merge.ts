import type { InboxItem, LocalMessage, PublicMessage } from "./types";

/**
 * 客户端合并规则（网页与 App 一致）：
 * - 同一条消息以 id 识别；本地乐观消息以 clientMessageId 对上服务端回执，不会出现两条。
 * - 服务端消息按 seq 排序；没有 seq 的本地待发消息排在最后。
 * - 撤回是单向的：先收到撤回、后收到旧的消息快照，也不会把正文复活。
 */
export function mergeMessages(current: LocalMessage[], incoming: PublicMessage[]): LocalMessage[] {
  const byId = new Map<string, LocalMessage>();
  const byClient = new Map<string, string>();
  for (const message of current) {
    byId.set(message.id, message);
    if (message.clientMessageId) byClient.set(message.clientMessageId, message.id);
  }
  for (const message of incoming) {
    const localId = message.clientMessageId ? byClient.get(message.clientMessageId) : undefined;
    if (localId && localId !== message.id) byId.delete(localId);
    const existing = byId.get(message.id);
    if (existing?.recalledAt && !message.recalledAt) {
      byId.set(message.id, { ...message, body: null, attachment: null, metadata: {}, recalledAt: existing.recalledAt });
      continue;
    }
    byId.set(message.id, { ...message, read: message.read || Boolean(existing?.read && !message.recalledAt) });
  }
  return [...byId.values()].sort(compareMessages);
}

function compareMessages(a: LocalMessage, b: LocalMessage) {
  const aLocal = a.localStatus ? 1 : 0;
  const bLocal = b.localStatus ? 1 : 0;
  if (aLocal !== bLocal) return aLocal - bLocal;
  if (aLocal && bLocal) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return a.seq - b.seq;
}

/** 对方已读游标前进后，把自己发出的、序号不大于游标的消息标为已读。 */
export function applyPeerRead(messages: LocalMessage[], meSub: string, readerSub: string, lastReadSeq: number): LocalMessage[] {
  if (readerSub === meSub) return messages;
  return messages.map((message) =>
    message.senderSub === meSub && !message.localStatus && !message.recalledAt && message.seq <= lastReadSeq && !message.read
      ? { ...message, read: true }
      : message,
  );
}

export function bumpInbox(items: InboxItem[], message: PublicMessage, meSub: string, viewingId: string | null): InboxItem[] {
  const preview = message.recalledAt
    ? "已撤回"
    : message.type === "IMAGE"
      ? "[图片]"
      : message.type === "FILE"
        ? `[文件] ${message.body || ""}`
        : (message.body || "").replace(/\s+/g, " ").slice(0, 80);
  let found = false;
  const next = items.map((item) => {
    if (item.id !== message.conversationId) return item;
    found = true;
    if (message.seq < item.lastMessageSeq) return item;
    const mine = message.senderSub === meSub;
    const unread = mine || item.id === viewingId ? item.unreadCount : item.unreadCount + (message.seq > item.lastMessageSeq ? 1 : 0);
    return {
      ...item,
      lastMessagePreview: preview,
      lastMessageAt: message.createdAt,
      lastMessageSeq: Math.max(item.lastMessageSeq, message.seq),
      unreadCount: unread,
    };
  });
  return found ? sortInbox(next) : next;
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.lastMessageAt || "1970-01-01") - Date.parse(a.lastMessageAt || "1970-01-01");
  });
}

/** 按 seq 去重的事件游标：处理过的 seq 不再处理，跳号时需要补拉。 */
export class SeqCursor {
  constructor(public value = 0) {}
  accept(seq: number): "new" | "duplicate" | "gap" {
    if (seq <= this.value) return "duplicate";
    if (seq > this.value + 1) return "gap";
    this.value = seq;
    return "new";
  }
}
