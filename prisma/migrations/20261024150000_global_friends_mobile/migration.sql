-- 全球好友、原生 App 与可靠同步。只增不删：不改旧列含义，不删旧表，旧消息与会话全部保留。

-- AlterTable：可撤销来源会话、会话消息序号、已读游标、投影来源
ALTER TABLE "BrowserSession" ADD COLUMN "accountSid" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "lastMessageSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ConversationMember" ADD COLUMN "lastReadSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UserProjection" ADD COLUMN "profileSource" TEXT NOT NULL DEFAULT 'HINT';

-- 旧消息按 (createdAt, id) 编号。先加可空列，回填后再收紧为 NOT NULL。
ALTER TABLE "Message" ADD COLUMN "seq" INTEGER;
UPDATE "Message" m
SET "seq" = numbered.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "conversationId" ORDER BY "createdAt", "id") AS rn
  FROM "Message"
) AS numbered
WHERE numbered."id" = m."id";
ALTER TABLE "Message" ALTER COLUMN "seq" SET NOT NULL;
CREATE UNIQUE INDEX "Message_conversationId_seq_key" ON "Message"("conversationId", "seq");

UPDATE "Conversation" c
SET "lastMessageSeq" = COALESCE((SELECT MAX(m."seq") FROM "Message" m WHERE m."conversationId" = c."id"), 0);

-- 已读游标：lastReadAt 不早于消息时间的视为已读，与旧的已读判断一致。
UPDATE "ConversationMember" cm
SET "lastReadSeq" = COALESCE((
  SELECT MAX(m."seq") FROM "Message" m
  WHERE m."conversationId" = cm."conversationId"
    AND cm."lastReadAt" IS NOT NULL
    AND m."createdAt" <= cm."lastReadAt"
), 0);

-- CreateTable
CREATE TABLE "FriendRequest" (
    "id" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "requesterSub" TEXT NOT NULL,
    "addresseeSub" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pendingPairKey" TEXT,
    "message" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'search',
    "clientRequestId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friendship" (
    "pairKey" TEXT NOT NULL,
    "subA" TEXT NOT NULL,
    "subB" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "establishedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedBySub" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("pairKey")
);

-- CreateTable
CREATE TABLE "ContactNote" (
    "id" TEXT NOT NULL,
    "ownerSub" TEXT NOT NULL,
    "targetSub" TEXT NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBlock" (
    "id" TEXT NOT NULL,
    "blockerSub" TEXT NOT NULL,
    "blockedSub" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectGrant" (
    "id" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceProduct" TEXT NOT NULL,
    "businessType" TEXT,
    "businessRefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "DirectGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReport" (
    "id" TEXT NOT NULL,
    "reporterSub" TEXT NOT NULL,
    "targetSub" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "messageSnapshot" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT NOT NULL DEFAULT '',
    "handledBySub" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacySetting" (
    "accountSub" TEXT NOT NULL,
    "discoverByKkNumber" BOOLEAN NOT NULL DEFAULT true,
    "discoverByUsername" BOOLEAN NOT NULL DEFAULT true,
    "discoverByName" BOOLEAN NOT NULL DEFAULT true,
    "allowFriendRequests" BOOLEAN NOT NULL DEFAULT true,
    "hideNotificationContent" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacySetting_pkey" PRIMARY KEY ("accountSub")
);

-- CreateTable
CREATE TABLE "InviteLink" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ownerSub" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSyncState" (
    "accountSub" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSyncState_pkey" PRIMARY KEY ("accountSub")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "accountSub" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "conversationId" TEXT,
    "payloadJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("accountSub","seq")
);

-- CreateTable
CREATE TABLE "NativeLoginTransaction" (
    "id" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "deviceName" TEXT NOT NULL DEFAULT '',
    "deviceSessionId" TEXT,
    "resultSealed" TEXT,
    "resultExpiresAt" TIMESTAMP(3),
    "exchangeStartedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeLoginTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "accountSub" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountSid" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL DEFAULT '',
    "appVersion" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "sourceCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceRefreshToken" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedRequestId" TEXT,
    "replacementSealed" TEXT,
    "retryUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "accountSub" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "ownerSub" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "messageId" TEXT,
    "clientUploadId" TEXT,
    "attachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FriendRequest_pendingPairKey_key" ON "FriendRequest"("pendingPairKey");

-- CreateIndex
CREATE INDEX "FriendRequest_addresseeSub_status_idx" ON "FriendRequest"("addresseeSub", "status");

-- CreateIndex
CREATE INDEX "FriendRequest_requesterSub_status_idx" ON "FriendRequest"("requesterSub", "status");

-- CreateIndex
CREATE INDEX "FriendRequest_pairKey_createdAt_idx" ON "FriendRequest"("pairKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FriendRequest_requesterSub_clientRequestId_key" ON "FriendRequest"("requesterSub", "clientRequestId");

-- CreateIndex
CREATE INDEX "Friendship_subA_status_idx" ON "Friendship"("subA", "status");

-- CreateIndex
CREATE INDEX "Friendship_subB_status_idx" ON "Friendship"("subB", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContactNote_ownerSub_targetSub_key" ON "ContactNote"("ownerSub", "targetSub");

-- CreateIndex
CREATE INDEX "UserBlock_blockedSub_idx" ON "UserBlock"("blockedSub");

-- CreateIndex
CREATE UNIQUE INDEX "UserBlock_blockerSub_blockedSub_key" ON "UserBlock"("blockerSub", "blockedSub");

-- CreateIndex
CREATE INDEX "DirectGrant_pairKey_revokedAt_idx" ON "DirectGrant"("pairKey", "revokedAt");

-- CreateIndex
CREATE INDEX "UserReport_status_createdAt_idx" ON "UserReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "UserReport_reporterSub_createdAt_idx" ON "UserReport"("reporterSub", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InviteLink_tokenHash_key" ON "InviteLink"("tokenHash");

-- CreateIndex
CREATE INDEX "InviteLink_ownerSub_createdAt_idx" ON "InviteLink"("ownerSub", "createdAt");

-- CreateIndex
CREATE INDEX "SyncEvent_createdAt_idx" ON "SyncEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeLoginTransaction_state_key" ON "NativeLoginTransaction"("state");

-- CreateIndex
CREATE UNIQUE INDEX "NativeLoginTransaction_deviceSessionId_key" ON "NativeLoginTransaction"("deviceSessionId");

-- CreateIndex
CREATE INDEX "NativeLoginTransaction_expiresAt_idx" ON "NativeLoginTransaction"("expiresAt");

-- CreateIndex
CREATE INDEX "DeviceSession_accountSub_idx" ON "DeviceSession"("accountSub");

-- CreateIndex
CREATE INDEX "DeviceSession_accountSid_idx" ON "DeviceSession"("accountSid");

-- CreateIndex
CREATE INDEX "DeviceSession_revokedAt_lastSeenAt_idx" ON "DeviceSession"("revokedAt", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRefreshToken_tokenHash_key" ON "DeviceRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceRefreshToken_sessionId_idx" ON "DeviceRefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "PushDevice_accountSub_revokedAt_idx" ON "PushDevice"("accountSub", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_provider_token_key" ON "PushDevice"("provider", "token");

-- CreateIndex
CREATE INDEX "Attachment_conversationId_idx" ON "Attachment"("conversationId");

-- CreateIndex
CREATE INDEX "Attachment_status_createdAt_idx" ON "Attachment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_ownerSub_clientUploadId_key" ON "Attachment"("ownerSub", "clientUploadId");

-- CreateIndex
CREATE INDEX "BrowserSession_accountSid_idx" ON "BrowserSession"("accountSid");

-- CreateIndex

-- AddForeignKey
ALTER TABLE "DeviceRefreshToken" ADD CONSTRAINT "DeviceRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DeviceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DeviceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 升级前已经存在的私聊：显式记录兼容授权，继续可以互发。删除好友或拉黑时撤销。
-- 新会话不再走这条路：普通用户必须先成为好友。
INSERT INTO "DirectGrant" ("id", "pairKey", "kind", "sourceProduct", "businessType", "businessRefId", "createdAt")
SELECT gen_random_uuid()::text, c."directKey", 'LEGACY', c."sourceProduct", c."businessType", c."businessRefId", CURRENT_TIMESTAMP
FROM "Conversation" c
WHERE c."kind" = 'DIRECT' AND c."directKey" IS NOT NULL;
