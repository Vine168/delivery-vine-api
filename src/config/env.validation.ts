import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { Transform } from 'class-transformer';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

const toInt = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : Number.parseInt(String(value), 10)));

const toBool = () =>
  Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === '') return undefined;
    return String(value).toLowerCase() === 'true';
  });

/**
 * The single source of truth for every environment variable the app reads.
 * Boot fails loudly here rather than at the first request that needs a value.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @toInt()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  @IsOptional()
  HOST = '0.0.0.0';

  @IsString()
  @IsOptional()
  API_PREFIX = 'api';

  @IsString()
  @IsOptional()
  CORS_ORIGINS = '*';

  // ── Database ──
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @toInt()
  @IsInt()
  @IsOptional()
  DATABASE_POOL_SIZE = 10;

  // ── JWT ──
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_EXPIRES_IN = '15m';

  @IsString()
  @MinLength(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' })
  JWT_REFRESH_SECRET: string;

  @IsString()
  @IsOptional()
  JWT_REFRESH_EXPIRES_IN = '30d';

  @IsString()
  @IsOptional()
  JWT_ISSUER = 'deliver-api';

  // ── Redis ──
  @IsString()
  @IsNotEmpty()
  REDIS_URL: string;

  @IsString()
  @IsOptional()
  REDIS_KEY_PREFIX = 'deliver:';

  // ── Object storage (MinIO / S3) ──
  @IsString()
  @IsNotEmpty()
  STORAGE_ENDPOINT: string;

  @toInt()
  @IsInt()
  @IsOptional()
  STORAGE_PORT = 9000;

  @toBool()
  @IsBoolean()
  @IsOptional()
  STORAGE_USE_SSL = false;

  @IsString()
  @IsNotEmpty()
  STORAGE_ACCESS_KEY: string;

  @IsString()
  @IsNotEmpty()
  STORAGE_SECRET_KEY: string;

  @IsString()
  @IsOptional()
  STORAGE_BUCKET = 'deliver';

  @IsString()
  @IsOptional()
  STORAGE_PUBLIC_BUCKET = 'deliver-public';

  @IsString()
  @IsOptional()
  STORAGE_REGION = 'us-east-1';

  @toInt()
  @IsInt()
  @IsOptional()
  STORAGE_SIGNED_URL_TTL_SECONDS = 900;

  @toInt()
  @IsInt()
  @IsOptional()
  STORAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  // ── Map provider (RokTenh / openrouteservice) ──
  @IsUrl({ require_tld: false })
  MAP_BASE_URL: string;

  @IsString()
  @IsNotEmpty()
  MAP_API_KEY: string;

  @toInt()
  @IsInt()
  @IsOptional()
  MAP_TIMEOUT_MS = 8000;

  @toInt()
  @IsInt()
  @IsOptional()
  MAP_CACHE_TTL_SECONDS = 86400;

  @toBool()
  @IsBoolean()
  @IsOptional()
  MAP_ALLOW_HAVERSINE_FALLBACK = true;

  // ── OTP ──
  @toInt()
  @IsInt()
  @Min(4)
  @Max(8)
  @IsOptional()
  OTP_LENGTH = 6;

  @toInt()
  @IsInt()
  @IsOptional()
  OTP_TTL_SECONDS = 300;

  @toInt()
  @IsInt()
  @IsOptional()
  OTP_MAX_ATTEMPTS = 5;

  @toInt()
  @IsInt()
  @IsOptional()
  OTP_RESEND_COOLDOWN_SECONDS = 60;

  @toInt()
  @IsInt()
  @IsOptional()
  OTP_MAX_PER_HOUR = 5;

  @toInt()
  @IsInt()
  @IsOptional()
  OTP_VERIFICATION_TOKEN_TTL_SECONDS = 900;

  @toBool()
  @IsBoolean()
  @IsOptional()
  OTP_EXPOSE_IN_RESPONSE = false;

  /**
   * The timezone business days are reported in. Storage stays UTC; this only
   * decides where "today" starts on a dashboard.
   */
  @IsString()
  @IsOptional()
  @MaxLength(64)
  APP_TIMEZONE = 'Asia/Phnom_Penh';

  // ── Delivery / matching ──
  @IsString()
  @IsOptional()
  @MaxLength(8)
  BOOKING_CODE_PREFIX = 'ORD';

  @toInt()
  @IsInt()
  @IsOptional()
  DELIVERY_ARRIVAL_RADIUS_METERS = 300;

  @toInt()
  @IsInt()
  @IsOptional()
  DELIVERY_STALLED_AFTER_MINUTES = 10;

  @toInt()
  @IsInt()
  @IsOptional()
  MATCHING_RADIUS_METERS = 5000;

  @toInt()
  @IsInt()
  @IsOptional()
  MATCHING_MAX_RADIUS_METERS = 15000;

  @toInt()
  @IsInt()
  @IsOptional()
  MATCHING_BATCH_SIZE = 5;

  @toInt()
  @IsInt()
  @IsOptional()
  MATCHING_OFFER_TTL_SECONDS = 30;

  @toInt()
  @IsInt()
  @IsOptional()
  MATCHING_MAX_ROUNDS = 4;

  @toBool()
  @IsBoolean()
  @IsOptional()
  MATCHING_ENABLED = true;

  @toInt()
  @IsInt()
  @IsOptional()
  DRIVER_PRESENCE_TTL_SECONDS = 60;

  @toInt()
  @IsInt()
  @IsOptional()
  TRACK_POINT_MIN_INTERVAL_SECONDS = 20;

  // ── Payouts ──
  @toInt()
  @IsInt()
  @IsOptional()
  WITHDRAWAL_MIN_AMOUNT_KHR = 20_000;

  @toInt()
  @IsInt()
  @IsOptional()
  WITHDRAWAL_MAX_AMOUNT_KHR = 4_000_000;

  @toInt()
  @IsInt()
  @IsOptional()
  WITHDRAWAL_FEE_KHR = 0;

  // ── Payments (ABA PayWay) ──
  @IsString()
  @IsOptional()
  PAYWAY_BASE_URL = 'https://checkout-sandbox.payway.com.kh';

  @IsString()
  @IsOptional()
  PAYWAY_MERCHANT_ID?: string;

  @IsString()
  @IsOptional()
  PAYWAY_API_KEY?: string;

  @IsString()
  @IsOptional()
  PAYWAY_CURRENCIES = 'USD';

  @toInt()
  @IsInt()
  @IsOptional()
  PAYWAY_LIFETIME_MINUTES = 15;

  @IsString()
  @IsOptional()
  PAYWAY_RETURN_URL?: string;

  // ── Push notifications ──
  @IsString()
  @IsOptional()
  FCM_PROJECT_ID?: string;

  @IsString()
  @IsOptional()
  FCM_CLIENT_EMAIL?: string;

  @IsString()
  @IsOptional()
  FCM_PRIVATE_KEY?: string;

  // ── Misc ──
  @IsString()
  @IsOptional()
  LOG_LEVEL = 'info';

  @toBool()
  @IsBoolean()
  @IsOptional()
  SWAGGER_ENABLED = true;

  @IsString()
  @MinLength(32, { message: 'ENCRYPTION_KEY must be at least 32 characters' })
  ENCRYPTION_KEY: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((e) => `  • ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return validated;
}
