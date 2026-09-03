import { registerAs } from '@nestjs/config';

export const storageConfig = registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT as string,
  port: Number(process.env.STORAGE_PORT ?? 9000),
  useSSL: process.env.STORAGE_USE_SSL === 'true',
  accessKey: process.env.STORAGE_ACCESS_KEY as string,
  secretKey: process.env.STORAGE_SECRET_KEY as string,
  /// Private bucket — driver documents, proof of delivery, chat attachments.
  bucket: process.env.STORAGE_BUCKET ?? 'deliver',
  /// Public bucket — avatars and other non-sensitive assets.
  publicBucket: process.env.STORAGE_PUBLIC_BUCKET ?? 'deliver-public',
  region: process.env.STORAGE_REGION ?? 'us-east-1',
  signedUrlTtlSeconds: Number(process.env.STORAGE_SIGNED_URL_TTL_SECONDS ?? 900),
  maxUploadBytes: Number(process.env.STORAGE_MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
}));

export type StorageConfig = ReturnType<typeof storageConfig>;
