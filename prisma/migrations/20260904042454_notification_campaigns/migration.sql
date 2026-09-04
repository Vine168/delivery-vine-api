-- CreateEnum
CREATE TYPE "CampaignAudience" AS ENUM ('ALL_CUSTOMERS', 'ALL_DRIVERS', 'APPROVED_DRIVERS', 'ONLINE_DRIVERS', 'DRIVERS_IN_ZONE', 'SPECIFIC_USERS');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('QUEUED', 'SENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "NotificationCampaign" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'SYSTEM_ANNOUNCEMENT',
    "audience" "CampaignAudience" NOT NULL,
    "filters" JSONB,
    "data" JSONB,
    "status" "CampaignStatus" NOT NULL DEFAULT 'QUEUED',
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationCampaign_status_createdAt_idx" ON "NotificationCampaign"("status", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationCampaign_createdAt_idx" ON "NotificationCampaign"("createdAt");

-- AddForeignKey
ALTER TABLE "NotificationCampaign" ADD CONSTRAINT "NotificationCampaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
