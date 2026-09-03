export const METADATA_KEY = {
  IS_PUBLIC: 'auth:isPublic',
  ROLES: 'auth:roles',
  RESPONSE_CODE: 'response:code',
  RESPONSE_MESSAGE: 'response:message',
  RATE_LIMIT: 'rateLimit:options',
  IDEMPOTENT: 'idempotency:enabled',
} as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  DEFAULT_CURSOR_LIMIT: 30,
  MAX_CURSOR_LIMIT: 100,
} as const;

export const LIMITS = {
  MAX_CUSTOMER_ADDRESSES: 30,
  MAX_PACKAGE_TEMPLATES: 30,
  MAX_PACKAGES_PER_DELIVERY: 20,
  MAX_DELIVERY_DISTANCE_METERS: 100_000,
  MIN_PICKUP_DROPOFF_DISTANCE_METERS: 50,
  MAX_REQUEST_BODY_BYTES: 1_048_576, // 1 MB — file uploads use multipart limits
} as const;

export const REQUEST_ID_HEADER = 'x-request-id';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Multipart upload rules, enforced by MIME sniffing rather than extension. */
export const UPLOAD_RULES = {
  IMAGE_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  DOCUMENT_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  MAX_IMAGE_BYTES: 8 * 1024 * 1024,
  MAX_DOCUMENT_BYTES: 10 * 1024 * 1024,
} as const;
