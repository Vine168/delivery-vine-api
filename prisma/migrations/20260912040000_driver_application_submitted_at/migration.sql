-- Records when a driver handed their completed application in.
--
-- Nullable and additive: existing drivers keep working untouched, and a null
-- simply means "still filling it out".
ALTER TABLE "DriverProfile" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMPTZ(3);
