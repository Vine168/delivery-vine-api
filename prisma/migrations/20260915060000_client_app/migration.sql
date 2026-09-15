-- Which of the two apps an installation, session or notification belongs to.
--
-- One account signs in to both the customer and the driver app, so the
-- account alone cannot say where a push should go or which inbox should show
-- it. Every column is nullable: null means "not known", which is what every
-- existing row is, and an unknown app keeps receiving everything as before.
CREATE TYPE "ClientApp" AS ENUM ('CUSTOMER', 'DRIVER');

ALTER TABLE "Device" ADD COLUMN "app" "ClientApp";
ALTER TABLE "UserSession" ADD COLUMN "app" "ClientApp";
ALTER TABLE "Notification" ADD COLUMN "app" "ClientApp";

-- Existing notifications are placed by type, the rule new ones follow. Every
-- cancellation sent so far was the customer's; account notices, chat and
-- announcements stay in both inboxes.
UPDATE "Notification" SET "app" = 'DRIVER'
WHERE "type" IN (
  'NEW_JOB_REQUEST',
  'JOB_REQUEST_EXPIRED',
  'WALLET_CREDITED',
  'WITHDRAWAL_STATUS_UPDATED',
  'DOCUMENT_REVIEWED'
);

UPDATE "Notification" SET "app" = 'CUSTOMER'
WHERE "type" IN (
  'DELIVERY_CREATED',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED_PICKUP',
  'PACKAGE_PICKED_UP',
  'DELIVERY_IN_TRANSIT',
  'DRIVER_ARRIVED_DROPOFF',
  'DELIVERY_COMPLETED',
  'DELIVERY_CANCELLED',
  'PAYMENT_STATUS_UPDATED'
);
