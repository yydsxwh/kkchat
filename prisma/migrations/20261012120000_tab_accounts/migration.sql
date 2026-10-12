CREATE TABLE "KkDevice" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "explicitPick" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "KkDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KkDevice_tokenHash_key" ON "KkDevice"("tokenHash");

CREATE TABLE "KkDeviceAccount" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "accountSub" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "KkDeviceAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KkDeviceAccount_deviceId_accountSub_key" ON "KkDeviceAccount"("deviceId", "accountSub");
ALTER TABLE "KkDeviceAccount" ADD CONSTRAINT "KkDeviceAccount_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "KkDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "KkTab" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "KkTab_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KkTab_deviceId_idx" ON "KkTab"("deviceId");
ALTER TABLE "KkTab" ADD CONSTRAINT "KkTab_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "KkDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "KkOidcAttempt" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "sealed" TEXT NOT NULL,
  "tabContextId" TEXT NOT NULL DEFAULT '',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "KkOidcAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KkOidcAttempt_stateHash_key" ON "KkOidcAttempt"("stateHash");
