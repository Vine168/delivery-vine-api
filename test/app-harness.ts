import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { Currency } from '../src/generated/prisma/enums.js';
import { MAP_PROVIDER } from '../src/modules/locations/providers/map-provider.interface.js';
import { FakeMapProvider } from './fake-map.provider.js';
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DeliveryMatchingService } from '../src/modules/delivery-matching/delivery-matching.service.js';
import { RedisService } from '../src/redis/redis.service.js';

export interface TestHarness {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  map: FakeMapProvider;
  /** Where the app is actually listening — socket clients need a real URL. */
  url: string;
  /** MATCHING_ENABLED is off in tests; specs run rounds themselves. */
  matching: DeliveryMatchingService;
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
  // The map provider is the one dependency we stub: prices depend on
  // distances, and a test's expected price cannot depend on what a live
  // routing engine returns today.
  const map = new FakeMapProvider();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAP_PROVIDER)
    .useValue(map)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('api', { exclude: ['health', 'health/live'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  // Concurrency specs fire several requests at once; without a listening
  // server supertest binds a fresh ephemeral port per call and they reset
  // each other.
  await app.listen(0);

  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);
  const matching = app.get(DeliveryMatchingService);

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

    await prisma.promoCode.createMany({
      data: [
        {
          code: 'SAVE500',
          name: 'Save ៛500',
          currency: Currency.KHR,
          discountType: 'FIXED_AMOUNT',
          discountValue: 500,
          minOrderAmount: 5_000,
          startsAt: new Date('2026-01-01'),
          endsAt: new Date('2027-01-01'),
          perCustomerLimit: 3,
        },
        {
          code: 'NEW10',
          name: '10% off your first delivery',
          currency: Currency.KHR,
          discountType: 'PERCENTAGE',
          discountValue: 1_000,
          maxDiscountAmount: 3_000,
          startsAt: new Date('2026-01-01'),
          endsAt: new Date('2027-01-01'),
          perCustomerLimit: 1,
        },
      ],
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
    map,
    matching,
    url,
    reset,
    expireOtpCooldowns,
    close: async () => {
      await app.close();
    },
  };
}
