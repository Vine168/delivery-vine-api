import { registerAs } from '@nestjs/config';

export const redisConfig = registerAs('redis', () => ({
  url: process.env.REDIS_URL as string,
  keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'deliver:',
}));

export type RedisConfig = ReturnType<typeof redisConfig>;
