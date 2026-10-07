import type { ExternalNotifyPlan } from "./chat-service";
import { loadConfig } from "./config";

/**
 * 把已经决定好的提醒交给 Platform。
 * 这里失败不能影响聊天落库；调用方应吞掉错误。
 * 不记录 OpenID、密钥或完整正文。
 */
export async function dispatchWechatPlans(plans: ExternalNotifyPlan[], conversationUrl: string): Promise<number> {
  if (plans.length === 0) return 0;
  const config = loadConfig();
  if (!config.platformBaseUrl || !config.platformServiceToken) return 0;
  let sent = 0;
  for (const plan of plans) {
    const body = {
      eventId: plan.eventId,
      productId: "kkchat",
      eventType: plan.eventType,
      recipientUserSub: plan.recipientSub,
      requestedChannels: ["WECHAT"],
      priority: "NORMAL",
      privacyClass: "NORMAL",
      audience: plan.eventType === "COURSE_TEACHER_ANNOUNCEMENT" ? "STUDENT" : "WATCHER",
      templateData: plan.templateData,
      webUrl: conversationUrl,
      dedupeKey: plan.dedupeKey,
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
      if (response.ok) sent += 1;
    } catch {
      // 微信失败只跳过这一条，聊天记录已经在库里。
    }
  }
  return sent;
}
