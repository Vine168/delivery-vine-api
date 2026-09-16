-- Credentials that would otherwise live in a .env file.
--
-- Values are encrypted with SECRETS_MASTER_KEY, which is never stored here:
-- the key to a store cannot live inside the store. There is no HTTP endpoint
-- for this table, unlike "SystemSetting" — these are read at boot only.
CREATE TABLE "AppSecret" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "description" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppSecret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppSecret_key_key" ON "AppSecret"("key");
