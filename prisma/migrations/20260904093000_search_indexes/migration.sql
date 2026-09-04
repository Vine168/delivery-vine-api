-- Back-office search is `ILIKE '%term%'` on booking codes, addresses, names,
-- phone numbers and plates. A B-tree cannot serve a leading wildcard, so every
-- one of those was a sequential scan — fine at launch, and progressively worse
-- as deliveries accumulate at tens of thousands a month.
--
-- Trigram GIN indexes serve exactly this shape of query. They are only built
-- on the columns the admin API actually searches, and only on tables that grow
-- without bound; zones and promo codes stay unindexed because they are small
-- enough that a scan is the cheaper plan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Delivery_bookingCode_trgm"
  ON "Delivery" USING gin ("bookingCode" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Delivery_pickupAddress_trgm"
  ON "Delivery" USING gin ("pickupAddress" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Delivery_dropoffAddress_trgm"
  ON "Delivery" USING gin ("dropoffAddress" gin_trgm_ops);

-- Support searches by whichever phone number the caller reads out, so the
-- delivery's own contact numbers matter as much as the account's.
CREATE INDEX IF NOT EXISTS "Delivery_pickupContactPhone_trgm"
  ON "Delivery" USING gin ("pickupContactPhone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Delivery_dropoffContactPhone_trgm"
  ON "Delivery" USING gin ("dropoffContactPhone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "User_phone_trgm"
  ON "User" USING gin ("phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "DriverProfile_fullName_trgm"
  ON "DriverProfile" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "CustomerProfile_fullName_trgm"
  ON "CustomerProfile" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "DriverVehicle_plateNumber_trgm"
  ON "DriverVehicle" USING gin ("plateNumber" gin_trgm_ops);
