import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { Currency } from '../src/generated/prisma/enums.js';
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';

export interface TestHarness {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  close: () => Promise<void>;
  reset: () => Promise<void>;
  expireOtpCooldowns: () => Promise<void>;
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

  /**
   * Reference data every e2e spec can rely on. Truncation wipes the seeded
   * rows, so they are recreated after each reset — kept minimal on purpose so
   * a test that needs unusual pricing sets it up itself.
   */
  const seedReferenceData = async () => {
    const vehicleType = await prisma.vehicleType.create({
      data: {
        code: 'MOTOR',
        name: 'Motorbike',
        nameKm: 'ម៉ូតូ',
        routingProfile: 'MOTOR',
        maxWeightKg: 20,
        maxPackages: 3,
        sortOrder: 1,
      },
      select: { id: true },
    });

    await prisma.pricingRule.create({
      data: {
        name: 'MOTOR standard (KHR)',
        vehicleTypeId: vehicleType.id,
        currency: Currency.KHR,
        baseFare: 4_000,
        includedDistanceMeters: 2_000,
        pricePerKm: 1_000,
        minimumFare: 4_000,
        serviceFeeFlat: 500,
        codFeePercentBp: 100,
        commissionPercentBp: 2_000,
        minCommission: 1_000,
      },
    });
  };

  const reset = async () => {
    await prisma.truncateAll();
    await redis.client.flushdb();
    await seedReferenceData();
  };

  await reset();

  /**
   * Drops OTP resend cooldowns. Requesting a second code for the same number
   * inside the cooldown is a 429 by design, so a test that legitimately needs
   * to register the same number twice uses this to simulate the wait.
   */
  const expireOtpCooldowns = async () => {
    const prefix = redis.client.options.keyPrefix ?? '';
    const keys = await redis.client.keys(`${prefix}otp:cooldown:*`);
    if (keys.length) {
      await redis.client.del(...keys.map((key) => key.slice(prefix.length)));
    }
  };

  return {
    app,
    prisma,
    redis,
    reset,
    expireOtpCooldowns,
    close: async () => {
      await app.close();
    },
  };
}
