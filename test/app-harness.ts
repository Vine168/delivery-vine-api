import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';

export interface TestHarness {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  close: () => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Boots the real application against the test database and Redis. Nothing is
 * mocked: e2e tests exercise the same guards, pipes, filters and SQL that
 * production does.
 */
export async function createTestHarness(): Promise<TestHarness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('api', { exclude: ['health', 'health/live'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  const reset = async () => {
    await prisma.truncateAll();
    await redis.client.flushdb();
  };

  await reset();

  return {
    app,
    prisma,
    redis,
    reset,
    close: async () => {
      await app.close();
    },
  };
}
