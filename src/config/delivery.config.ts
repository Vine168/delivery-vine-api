import { registerAs } from '@nestjs/config';

export const deliveryConfig = registerAs('delivery', () => ({
  matchingRadiusMeters: Number(process.env.MATCHING_RADIUS_METERS ?? 5000),
  matchingMaxRadiusMeters: Number(process.env.MATCHING_MAX_RADIUS_METERS ?? 15000),
  matchingBatchSize: Number(process.env.MATCHING_BATCH_SIZE ?? 5),
  offerTtlSeconds: Number(process.env.MATCHING_OFFER_TTL_SECONDS ?? 30),
  maxRounds: Number(process.env.MATCHING_MAX_ROUNDS ?? 4),
  driverPresenceTtlSeconds: Number(process.env.DRIVER_PRESENCE_TTL_SECONDS ?? 60),
  trackPointMinIntervalSeconds: Number(process.env.TRACK_POINT_MIN_INTERVAL_SECONDS ?? 20),
}));

export type DeliveryConfig = ReturnType<typeof deliveryConfig>;
