import { registerAs } from '@nestjs/config';

export const deliveryConfig = registerAs('delivery', () => ({
  matchingRadiusMeters: Number(process.env.MATCHING_RADIUS_METERS ?? 5000),
  matchingMaxRadiusMeters: Number(process.env.MATCHING_MAX_RADIUS_METERS ?? 15000),
  matchingBatchSize: Number(process.env.MATCHING_BATCH_SIZE ?? 5),
  offerTtlSeconds: Number(process.env.MATCHING_OFFER_TTL_SECONDS ?? 30),
  maxRounds: Number(process.env.MATCHING_MAX_ROUNDS ?? 4),
  /// How long a booking may search before the back office calls it stuck.
  stalledAfterMinutes: Number(process.env.DELIVERY_STALLED_AFTER_MINUTES ?? 10),
  /// Turn off to stop bookings dispatching automatically (used by tests, which
  /// drive the matcher explicitly so their assertions are deterministic).
  matchingEnabled: process.env.MATCHING_ENABLED !== 'false',
  driverPresenceTtlSeconds: Number(process.env.DRIVER_PRESENCE_TTL_SECONDS ?? 60),
  trackPointMinIntervalSeconds: Number(process.env.TRACK_POINT_MIN_INTERVAL_SECONDS ?? 20),
}));

export type DeliveryConfig = ReturnType<typeof deliveryConfig>;
