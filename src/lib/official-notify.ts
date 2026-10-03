import { loadConfig } from "./config";

/**
 * 只给站长/官方消息发微信短摘要。普通用户互聊不走这里。
 * 平台没配好时跳过，不让聊天失败。
 */
export async function notifyOfficialMessage(input: {
  recipientSub: string;
  senderName: string;
  excerpt: string;
  conversationUrl: string;
}): Promise<{ status: "sent" | "skipped" }> {
  const config = loadConfig();
  if (!config.platformBaseUrl || !config.platformServiceToken) return { status: "skipped" };
  const excerpt = input.excerpt.replace(/\s+/g, " ").trim().slice(0, 20) || "你有一条新消息";
  const senderName = input.senderName.trim().slice(0, 20) || "KKChat";
  const body = {
    eventId: `kkchat:${input.recipientSub}:${Date.now()}`,
    productId: "kkchat",
    eventType: "KKCHAT_MESSAGE_RECEIVED",
    recipientUserSub: input.recipientSub,
    requestedChannels: ["WECHAT"],
    priority: "NORMAL",
    privacyClass: "NORMAL",
    audience: "WATCHER",
    templateData: {
      senderName,
      excerpt,
      occurredAt: new Date().toISOString().slice(0, 16).replace("T", " "),
    },
    webUrl: input.conversationUrl,
    dedupeKey: `kkchat:${input.recipientSub}:${excerpt}`,
    respectPreferences: true,
  };
  try {
    const response = await fetch(`${config.platformBaseUrl}/v1/notifications/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.platformServiceToken}`,
        "content-type": "application/json",
        "x-platform-client": "kkchat",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { status: "skipped" };
    return { status: "sent" };
  } catch {
    return { status: "skipped" };
  }
}
