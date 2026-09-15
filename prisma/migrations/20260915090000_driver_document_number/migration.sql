-- The number printed on a driver document — the national ID number above all
-- — as the driver typed it, so an operator can check it against the photo.
-- Encrypted at rest like a bank account number, with the last four kept apart
-- for showing back to the driver. The expiry date goes in the existing
-- "expiresAt" column, which nothing filled in until now.
--
-- Nullable and additive: documents submitted before this simply have none.
ALTER TABLE "DriverDocument"
  ADD COLUMN IF NOT EXISTS "documentNumberEnc" TEXT,
  ADD COLUMN IF NOT EXISTS "documentNumberLast4" TEXT;
