import { registerAs } from '@nestjs/config';

export const mapConfig = registerAs('map', () => ({
  baseUrl: (process.env.MAP_BASE_URL as string)?.replace(/\/+$/, ''),
  apiKey: process.env.MAP_API_KEY as string,
  timeoutMs: Number(process.env.MAP_TIMEOUT_MS ?? 8000),
  cacheTtlSeconds: Number(process.env.MAP_CACHE_TTL_SECONDS ?? 86400),
  /// When the provider is unreachable, fall back to straight-line distance so a
  /// customer can still get a quote. Disable in production if unacceptable.
  allowHaversineFallback: process.env.MAP_ALLOW_HAVERSINE_FALLBACK !== 'false',
}));

export type MapConfig = ReturnType<typeof mapConfig>;
