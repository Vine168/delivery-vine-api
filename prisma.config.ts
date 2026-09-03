import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer reads .env for us, and Node 24 can do it natively.
// An explicit DATABASE_URL in the environment always wins, so CI and the test
// database can be targeted without editing files.
if (!process.env.DATABASE_URL) {
  const file = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
  const resolved = path.join(process.cwd(), file);
  if (existsSync(resolved)) {
    process.loadEnvFile(resolved);
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'npm run db:seed',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
