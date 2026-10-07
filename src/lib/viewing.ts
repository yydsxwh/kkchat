/**
 * 正在看某个会话的人。只活在本进程，刷新或离开就过期。
 * 不把在线状态写进聊天库。
 */

const VIEWING_TTL_MS = 45_000;
const untilByKey = new Map<string, number>();

function key(accountSub: string, conversationId: string) {
  return `${accountSub}\n${conversationId}`;
}

export function markConversationViewing(accountSub: string, conversationId: string, now = Date.now()) {
  untilByKey.set(key(accountSub, conversationId), now + VIEWING_TTL_MS);
}

export function isConversationViewing(accountSub: string, conversationId: string, now = Date.now()) {
  const until = untilByKey.get(key(accountSub, conversationId));
  if (until == null || until <= now) {
    if (until != null) untilByKey.delete(key(accountSub, conversationId));
    return false;
  }
  return true;
}
