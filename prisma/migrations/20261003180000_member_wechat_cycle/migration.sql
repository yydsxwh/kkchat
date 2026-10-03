-- 记录这一轮未读是否已经发过外部提醒。可空，不影响已有会话。
ALTER TABLE "ConversationMember" ADD COLUMN "lastExternalNotifiedAt" TIMESTAMP(3);
