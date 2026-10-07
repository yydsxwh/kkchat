/**
 * 聊天微信提醒的规则。
 *
 * 未读从 0 变成 1 才提醒；持续未读合并成这一次。
 * 已读之后进入下一个周期，可以再提醒一次。
 * 正在看这个会话、已静音、已退群都不发。微信里只有短摘要。
 */

export const WECHAT_EXCERPT_FALLBACK = "你有一条新消息";
const EXCERPT_LIMIT = 20;

export type WechatNotifyDecision = {
  notify: boolean;
  reason: "left" | "muted" | "viewing" | "unread-open" | "already-notified" | "unread-opened";
};

export function wechatExcerpt(input: { type: string; body: string; announcement?: boolean }): string {
  const flat = input.body.replace(/\s+/g, " ").trim();
  if (!input.announcement && (input.type !== "TEXT" || looksLikeAttachment(flat))) {
    return WECHAT_EXCERPT_FALLBACK;
  }
  if (!flat) return input.announcement ? "请查看课程通知" : WECHAT_EXCERPT_FALLBACK;
  return flat.slice(0, EXCERPT_LIMIT);
}

export function shouldNotifyWechat(input: {
  previousUnread: number;
  muted: boolean;
  viewing: boolean;
  active: boolean;
  lastNotifiedAt: Date | null;
  lastReadAt: Date | null;
}): WechatNotifyDecision {
  if (!input.active) return { notify: false, reason: "left" };
  if (input.muted) return { notify: false, reason: "muted" };
  if (input.viewing) return { notify: false, reason: "viewing" };
  if (input.previousUnread > 0) return { notify: false, reason: "unread-open" };
  if (alreadyNotifiedThisCycle(input.lastNotifiedAt, input.lastReadAt)) {
    return { notify: false, reason: "already-notified" };
  }
  return { notify: true, reason: "unread-opened" };
}

/** 同一未读周期的键稳定，Platform 用它做幂等。已读后 lastReadAt 变化，下一轮才换键。 */
export function wechatCycleKey(input: {
  conversationId: string;
  recipientSub: string;
  lastReadAt: Date | null;
}): string {
  const cycle = input.lastReadAt ? input.lastReadAt.toISOString() : "new";
  return `kkchat:${input.conversationId}:${input.recipientSub}:${cycle}`;
}

function alreadyNotifiedThisCycle(lastNotifiedAt: Date | null, lastReadAt: Date | null): boolean {
  if (!lastNotifiedAt) return false;
  if (!lastReadAt) return true;
  return lastNotifiedAt.getTime() >= lastReadAt.getTime();
}

function looksLikeAttachment(text: string): boolean {
  if (!text) return false;
  return /https?:\/\//i.test(text) && /\.(png|jpe?g|gif|webp|pdf|zip|docx?|xlsx?)(\?|$)/i.test(text);
}
