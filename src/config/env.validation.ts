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

  // ── Sign-in protection ──
  @toInt()
  @IsInt()
  @Min(3)
  @IsOptional()
  LOGIN_MAX_ATTEMPTS = 10;

  @toInt()
  @IsInt()
  @IsOptional()
  LOGIN_ATTEMPT_WINDOW_SECONDS = 900;

  @toInt()
  @IsInt()
  @IsOptional()
  LOGIN_LOCK_SECONDS = 900;

  // ── SMS gateway (PlasGate) ──
  // All optional: with none of them set, OTP codes go to the log as before.
  @IsString()
  @IsOptional()
  PLASGATE_BASE_URL = 'https://cloudapi.plasgate.com/rest/send';

  @IsString()
  @IsOptional()
  PLASGATE_PRIVATE_KEY?: string;

  @IsString()
  @IsOptional()
  PLASGATE_SECRET_KEY?: string;

  @IsString()
  @IsOptional()
  @MaxLength(11)
  PLASGATE_SENDER?: string;

  @toInt()
  @IsInt()
  @IsOptional()
  PLASGATE_TIMEOUT_MS = 10_000;

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

  /**
   * Credentials for the documentation. Optional, and when unset the docs are
   * open — which production refuses to start with, since the document maps
   * every endpoint including the back office.
   */
  @IsString()
  @IsOptional()
  SWAGGER_USER?: string;

  @IsString()
  @MinLength(12, { message: 'SWAGGER_PASSWORD must be at least 12 characters' })
  @IsOptional()
  SWAGGER_PASSWORD?: string;

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

  assertSafeInProduction(validated);

  return validated;
}

/** Values that are obviously a placeholder rather than a secret. */
const PLACEHOLDER = /^$|change[-_ ]?me|your[-_ ]?secret|example|placeholder|^secret$|^password$|^xxx/i;

/**
 * Settings that are fine on a laptop and dangerous on a production host.
 *
 * Per-field validation cannot express these: each value is individually
 * legal, and only becomes a problem in combination with NODE_ENV. They are
 * checked at boot and refuse to start rather than warn, because a warning in
 * a startup log is read once and never again.
 *
 * This exists because two comments in the codebase promised that
 * OTP_EXPOSE_IN_RESPONSE was "validated to be false in production" and nothing
 * ever validated it — leaving an authentication bypass behind a note saying it
 * was handled.
 */
function assertSafeInProduction(env: EnvironmentVariables): void {
  if (env.NODE_ENV !== NodeEnv.Production) return;

  const problems: string[] = [];

  if (env.OTP_EXPOSE_IN_RESPONSE) {
    problems.push(
      'OTP_EXPOSE_IN_RESPONSE must be false in production — it returns verification codes in the API response, ' +
        'so anyone who can call register with someone else’s number receives their code.',
    );
  }

  if (env.CORS_ORIGINS.trim() === '*') {
    problems.push(
      'CORS_ORIGINS must name the origins you serve in production — the API sends credentials, ' +
        'and "*" lets any site make authenticated requests on a signed-in user’s behalf.',
    );
  }

  if (env.SWAGGER_ENABLED && !(env.SWAGGER_USER && env.SWAGGER_PASSWORD)) {
    problems.push(
      'SWAGGER_USER and SWAGGER_PASSWORD must both be set when SWAGGER_ENABLED is true in production — ' +
        'the document maps every endpoint including the back office, and leaving it open hands that map to anyone ' +
        'who finds the URL. Set SWAGGER_ENABLED=false instead if the docs are not needed there.',
    );
  }

  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY'] as const) {
    if (PLACEHOLDER.test(env[key] ?? '')) {
      problems.push(`${key} still looks like a placeholder rather than a generated secret.`);
    }
  }

  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ — sharing one means a stolen access token ' +
        'can be presented as a refresh token.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n${problems.map((p) => `  • ${p}`).join('\n')}`,
    );
  }
}
