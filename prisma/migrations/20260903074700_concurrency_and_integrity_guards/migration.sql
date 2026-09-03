-- ════════════════════════════════════════════════════════════════════════════
--  Guards that Prisma's schema language cannot express.
--  These are the last line of defence for the job-acceptance race: even if
--  application code is wrong, the database refuses a second active assignment.
-- ════════════════════════════════════════════════════════════════════════════

-- At most ONE accepted assignment per delivery.
CREATE UNIQUE INDEX "DeliveryAssignment_delivery_accepted_key"
  ON "DeliveryAssignment" ("deliveryId")
  WHERE "status" = 'ACCEPTED';

-- A driver may hold at most ONE accepted (in-flight) assignment at a time.
CREATE UNIQUE INDEX "DeliveryAssignment_driver_accepted_key"
  ON "DeliveryAssignment" ("driverId")
  WHERE "status" = 'ACCEPTED';

-- A driver may be attached to at most ONE delivery that is still in flight.
CREATE UNIQUE INDEX "Delivery_driver_active_key"
  ON "Delivery" ("driverId")
  WHERE "driverId" IS NOT NULL
    AND "status" IN ('DRIVER_ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DROPOFF');

-- Exactly one default address per customer.
CREATE UNIQUE INDEX "CustomerAddress_default_key"
  ON "CustomerAddress" ("customerId")
  WHERE "isDefault" AND "deletedAt" IS NULL;

-- Exactly one primary vehicle per driver.
CREATE UNIQUE INDEX "DriverVehicle_primary_key"
  ON "DriverVehicle" ("driverId")
  WHERE "isPrimary" AND "deletedAt" IS NULL;

-- One pending/approved document of each type per driver.
CREATE UNIQUE INDEX "DriverDocument_active_type_key"
  ON "DriverDocument" ("driverId", "type")
  WHERE "status" IN ('PENDING', 'APPROVED');

-- ── Domain invariants ──────────────────────────────────────────────────────

ALTER TABLE "DeliveryRating"
  ADD CONSTRAINT "DeliveryRating_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_balance_non_negative" CHECK ("balance" >= 0),
  ADD CONSTRAINT "Wallet_reserved_non_negative" CHECK ("reservedBalance" >= 0),
  ADD CONSTRAINT "Wallet_reserved_within_balance" CHECK ("reservedBalance" <= "balance");

ALTER TABLE "WalletTransaction"
  ADD CONSTRAINT "WalletTransaction_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "WalletTransaction_balance_non_negative" CHECK ("balanceBefore" >= 0 AND "balanceAfter" >= 0);

ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "Withdrawal_net_non_negative" CHECK ("netAmount" >= 0);

ALTER TABLE "Delivery"
  ADD CONSTRAINT "Delivery_total_non_negative" CHECK ("totalAmount" >= 0),
  ADD CONSTRAINT "Delivery_discount_non_negative" CHECK ("discountAmount" >= 0),
  ADD CONSTRAINT "Delivery_distance_non_negative" CHECK ("distanceMeters" >= 0),
  ADD CONSTRAINT "Delivery_cod_amount_positive" CHECK ("codAmount" IS NULL OR "codAmount" > 0),
  ADD CONSTRAINT "Delivery_cod_requires_currency" CHECK (NOT "codEnabled" OR ("codAmount" IS NOT NULL AND "codCurrency" IS NOT NULL AND "codPayer" IS NOT NULL));

ALTER TABLE "DriverEarning"
  ADD CONSTRAINT "DriverEarning_amounts_non_negative"
  CHECK ("deliveryAmount" >= 0 AND "commissionAmount" >= 0 AND "netAmount" >= 0);

-- Coordinates must be real points on Earth.
ALTER TABLE "Delivery"
  ADD CONSTRAINT "Delivery_pickup_coords_valid"
  CHECK ("pickupLatitude" BETWEEN -90 AND 90 AND "pickupLongitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "Delivery_dropoff_coords_valid"
  CHECK ("dropoffLatitude" BETWEEN -90 AND 90 AND "dropoffLongitude" BETWEEN -180 AND 180);

ALTER TABLE "CustomerAddress"
  ADD CONSTRAINT "CustomerAddress_coords_valid"
  CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);

ALTER TABLE "DriverLocation"
  ADD CONSTRAINT "DriverLocation_coords_valid"
  CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);
