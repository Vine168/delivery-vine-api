import { registerAs } from '@nestjs/config';
import { NodeEnv } from './env.validation.js';

export const appConfig = registerAs('app', () => ({
  env: (process.env.NODE_ENV ?? NodeEnv.Development) as NodeEnv,
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  apiPrefix: process.env.API_PREFIX ?? 'api',
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((o) => o.trim()),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /**
   * The document describes every endpoint, back office included, so it is
   * off in production unless someone deliberately turns it on.
   */
  swaggerEnabled:
    process.env.SWAGGER_ENABLED === 'true' ||
    (process.env.SWAGGER_ENABLED !== 'false' && process.env.NODE_ENV !== NodeEnv.Production),
  encryptionKey: process.env.ENCRYPTION_KEY as string,
  bookingCodePrefix: process.env.BOOKING_CODE_PREFIX ?? 'ORD',
  /** Reporting timezone. Storage is UTC; this is where a business day starts. */
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Phnom_Penh',
  isProduction: process.env.NODE_ENV === NodeEnv.Production,
}));

export type AppConfig = ReturnType<typeof appConfig>;
