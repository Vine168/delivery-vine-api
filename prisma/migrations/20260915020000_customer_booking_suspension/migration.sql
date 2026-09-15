-- Lets an operator stop someone booking without closing their account.
--
-- One account now serves both apps, so suspending a customer through
-- User.status would also stop them driving and lock them out of money they
-- have already earned. The booking side gets its own flag instead.
ALTER TABLE "CustomerProfile"
  ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "suspendedReason" TEXT;

-- Customer suspensions made before this move onto the profile. They only ever
-- meant "may not book": while customer and driver were separate logins, the
-- same person's driver account kept working. Moving them keeps exactly that.
-- The account's last update is the closest record of when it happened.
UPDATE "CustomerProfile" AS cp
SET "suspendedAt" = u."updatedAt",
    "suspendedReason" = u."suspendedReason"
FROM "User" AS u
WHERE cp."userId" = u."id"
  AND u."role" = 'CUSTOMER'
  AND u."status" = 'SUSPENDED'
  AND cp."suspendedAt" IS NULL;

UPDATE "User" AS u
SET "status" = 'ACTIVE',
    "suspendedReason" = NULL
FROM "CustomerProfile" AS cp
WHERE cp."userId" = u."id"
  AND u."role" = 'CUSTOMER'
  AND u."status" = 'SUSPENDED';
