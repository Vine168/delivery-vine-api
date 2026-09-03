import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL as string,
  poolSize: Number(process.env.DATABASE_POOL_SIZE ?? 10),
}));

export type DatabaseConfig = ReturnType<typeof databaseConfig>;
