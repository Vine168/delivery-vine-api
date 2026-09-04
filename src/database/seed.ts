/**
 * Reference data the platform cannot run without: vehicle types, their pricing
 * rules, and an exchange rate. Idempotent — safe to run against an existing
 * database, and safe to run repeatedly.
 *
 *   npm run db:seed
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { argon2id, hash } from 'argon2';
import { PrismaClient } from '../generated/prisma/client.js';
import { Currency, DiscountType, UserRole, UserStatus } from '../generated/prisma/enums.js';
import { PERMISSION_CATALOGUE, SYSTEM_ROLES } from '../modules/admin/permissions.catalogue.js';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
const envPath = path.join(process.cwd(), envFile);
if (!process.env.DATABASE_URL && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' }),
});

interface VehicleTypeSeed {
  code: string;
  name: string;
  nameKm: string;
  description: string;
  routingProfile: string;
  maxWeightKg: number;
  maxPackages: number;
  sortOrder: number;
  pricing: {
    /** Riel, and US cents. */
    khr: PricingSeed;
    usd: PricingSeed;
  };
}

interface PricingSeed {
  baseFare: number;
  includedDistanceMeters: number;
  pricePerKm: number;
  minimumFare: number;
  serviceFeeFlat: number;
  codFeePercentBp: number;
  commissionPercentBp: number;
  minCommission: number;
}

const VEHICLE_TYPES: VehicleTypeSeed[] = [
  {
    code: 'MOTOR',
    name: 'Motorbike',
    nameKm: 'ម៉ូតូ',
    description: 'Documents and small parcels up to 20 kg.',
    routingProfile: 'MOTOR',
    maxWeightKg: 20,
    maxPackages: 3,
    sortOrder: 1,
    pricing: {
      khr: {
        baseFare: 4_000,
        includedDistanceMeters: 2_000,
        pricePerKm: 1_000,
        minimumFare: 4_000,
        serviceFeeFlat: 500,
        codFeePercentBp: 100,
        commissionPercentBp: 2_000,
        minCommission: 1_000,
      },
      usd: {
        baseFare: 100,
        includedDistanceMeters: 2_000,
        pricePerKm: 25,
        minimumFare: 100,
        serviceFeeFlat: 12,
        codFeePercentBp: 100,
        commissionPercentBp: 2_000,
        minCommission: 25,
      },
    },
  },
  {
    code: 'TUKTUK',
    name: 'Tuk-tuk',
    nameKm: 'តុកតុក',
    description: 'Bulkier loads up to 100 kg.',
    routingProfile: 'MOTOR',
    maxWeightKg: 100,
    maxPackages: 8,
    sortOrder: 2,
    pricing: {
      khr: {
        baseFare: 6_000,
        includedDistanceMeters: 2_000,
        pricePerKm: 1_500,
        minimumFare: 6_000,
        serviceFeeFlat: 500,
        codFeePercentBp: 100,
        commissionPercentBp: 2_000,
        minCommission: 1_500,
      },
      usd: {
        baseFare: 150,
        includedDistanceMeters: 2_000,
        pricePerKm: 38,
        minimumFare: 150,
        serviceFeeFlat: 12,
        codFeePercentBp: 100,
        commissionPercentBp: 2_000,
        minCommission: 38,
      },
    },
  },
  {
    code: 'CAR',
    name: 'Car',
    nameKm: 'ឡាន',
    description: 'Fragile or weather-sensitive items up to 200 kg.',
    routingProfile: 'CAR',
    maxWeightKg: 200,
    maxPackages: 10,
    sortOrder: 3,
    pricing: {
      khr: {
        baseFare: 10_000,
        includedDistanceMeters: 2_000,
        pricePerKm: 2_000,
        minimumFare: 10_000,
        serviceFeeFlat: 1_000,
        codFeePercentBp: 100,
        commissionPercentBp: 1_800,
        minCommission: 2_000,
      },
      usd: {
        baseFare: 250,
        includedDistanceMeters: 2_000,
        pricePerKm: 50,
        minimumFare: 250,
        serviceFeeFlat: 25,
        codFeePercentBp: 100,
        commissionPercentBp: 1_800,
        minCommission: 50,
      },
    },
  },
  {
    code: 'VAN',
    name: 'Van',
    nameKm: 'ឡានដឹកទំនិញ',
    description: 'Large or multi-drop loads up to 800 kg.',
    routingProfile: 'CAR',
    maxWeightKg: 800,
    maxPackages: 30,
    sortOrder: 4,
    pricing: {
      khr: {
        baseFare: 20_000,
        includedDistanceMeters: 3_000,
        pricePerKm: 3_000,
        minimumFare: 20_000,
        serviceFeeFlat: 1_000,
        codFeePercentBp: 100,
        commissionPercentBp: 1_800,
        minCommission: 4_000,
      },
      usd: {
        baseFare: 500,
        includedDistanceMeters: 3_000,
        pricePerKm: 75,
        minimumFare: 500,
        serviceFeeFlat: 25,
        codFeePercentBp: 100,
        commissionPercentBp: 1_800,
        minCommission: 100,
      },
    },
  },
];

async function seedVehicleTypesAndPricing(): Promise<void> {
  for (const type of VEHICLE_TYPES) {
    const vehicleType = await prisma.vehicleType.upsert({
      where: { code: type.code },
      create: {
        code: type.code,
        name: type.name,
        nameKm: type.nameKm,
        description: type.description,
        routingProfile: type.routingProfile,
        maxWeightKg: type.maxWeightKg,
        maxPackages: type.maxPackages,
        sortOrder: type.sortOrder,
      },
      update: {
        name: type.name,
        nameKm: type.nameKm,
        description: type.description,
        routingProfile: type.routingProfile,
        maxWeightKg: type.maxWeightKg,
        maxPackages: type.maxPackages,
        sortOrder: type.sortOrder,
        isActive: true,
      },
      select: { id: true, code: true },
    });

    for (const [currency, pricing] of [
      [Currency.KHR, type.pricing.khr],
      [Currency.USD, type.pricing.usd],
    ] as const) {
      const name = `${type.code} standard (${currency})`;

      const existing = await prisma.pricingRule.findFirst({
        where: { vehicleTypeId: vehicleType.id, currency, name },
        select: { id: true },
      });

      const data = {
        name,
        vehicleTypeId: vehicleType.id,
        currency,
        ...pricing,
        priority: 0,
        isActive: true,
      };

      if (existing) {
        await prisma.pricingRule.update({ where: { id: existing.id }, data });
      } else {
        await prisma.pricingRule.create({ data });
      }
    }

    console.log(`  vehicle type ${type.code} + 2 pricing rules`);
  }
}

async function seedExchangeRates(): Promise<void> {
  const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');

  for (const [base, quote, rate] of [
    [Currency.USD, Currency.KHR, '4100.000000'],
    [Currency.KHR, Currency.USD, '0.000244'],
  ] as const) {
    await prisma.exchangeRate.upsert({
      where: {
        baseCurrency_quoteCurrency_effectiveFrom: {
          baseCurrency: base,
          quoteCurrency: quote,
          effectiveFrom,
        },
      },
      create: { baseCurrency: base, quoteCurrency: quote, rate, effectiveFrom, source: 'seed' },
      update: { rate },
    });
  }

  console.log('  exchange rates USD ↔ KHR');
}

async function seedPromoCodes(): Promise<void> {
  const startsAt = new Date('2026-01-01T00:00:00.000Z');
  const endsAt = new Date('2027-01-01T00:00:00.000Z');

  await prisma.promoCode.upsert({
    where: { code: 'SAVE500' },
    create: {
      code: 'SAVE500',
      name: 'Save ៛500',
      description: '៛500 off any delivery over ៛5,000.',
      currency: Currency.KHR,
      discountType: DiscountType.FIXED_AMOUNT,
      discountValue: 500,
      minOrderAmount: 5_000,
      startsAt,
      endsAt,
      usageLimit: 10_000,
      perCustomerLimit: 3,
    },
    update: { isActive: true, endsAt },
  });

  await prisma.promoCode.upsert({
    where: { code: 'NEW10' },
    create: {
      code: 'NEW10',
      name: '10% off your first delivery',
      description: '10% off, up to ៛3,000.',
      currency: Currency.KHR,
      discountType: DiscountType.PERCENTAGE,
      discountValue: 1_000, // 10.00% in basis points
      maxDiscountAmount: 3_000,
      startsAt,
      endsAt,
      perCustomerLimit: 1,
    },
    update: { isActive: true, endsAt },
  });

  console.log('  promo codes SAVE500, NEW10');
}

/**
 * The permission catalogue is the source of truth in code; this reconciles the
 * database to it. Codes that disappear from the catalogue are left in place
 * rather than deleted, because a role may still reference them and silently
 * narrowing an operator's access is worse than a stale row.
 */
async function seedPermissions(): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();

  for (const permission of PERMISSION_CATALOGUE) {
    const row = await prisma.permission.upsert({
      where: { code: permission.code },
      create: { ...permission, isSystem: true },
      update: { module: permission.module, action: permission.action, description: permission.description },
      select: { id: true, code: true },
    });

    byCode.set(row.code, row.id);
  }

  console.log(`  ${byCode.size} permissions`);
  return byCode;
}

async function seedRoles(permissionIds: Map<string, string>): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    const row = await prisma.role.upsert({
      where: { slug: role.slug },
      create: { name: role.name, slug: role.slug, description: role.description, isSystem: true },
      update: { name: role.name, description: role.description, isSystem: true },
      select: { id: true },
    });

    // Replace the set outright: the catalogue decides what a system role can do.
    await prisma.rolePermission.deleteMany({ where: { roleId: row.id } });
    await prisma.rolePermission.createMany({
      data: role.permissions
        .map((code) => permissionIds.get(code))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: row.id, permissionId })),
      skipDuplicates: true,
    });

    console.log(`  role ${role.name} (${role.permissions.length} permissions)`);
  }
}

/**
 * A way in on a fresh install.
 *
 * Created only when no back-office account exists at all, and only from
 * explicit environment variables — so a deployed environment without them has
 * no default credentials to guess.
 */
async function seedSuperAdmin(): Promise<void> {
  const phone = process.env.ADMIN_BOOTSTRAP_PHONE;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  const existing = await prisma.adminProfile.count();
  if (existing > 0) {
    console.log(`  ${existing} back-office account(s) already exist; skipping bootstrap`);
    return;
  }

  if (!phone || !password) {
    console.log('  no ADMIN_BOOTSTRAP_PHONE/PASSWORD set; no super admin created');
    return;
  }

  const passwordHash = await hash(password, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  const user = await prisma.user.upsert({
    where: { phone_role: { phone, role: UserRole.ADMIN } },
    create: {
      phone,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      passwordHash,
      phoneVerifiedAt: new Date(),
    },
    update: { passwordHash, status: UserStatus.ACTIVE },
    select: { id: true },
  });

  await prisma.adminProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, fullName: 'Super Admin', isSuperAdmin: true },
    update: { isSuperAdmin: true },
  });

  console.log(`  super admin created for ${phone}`);
}

async function main(): Promise<void> {
  console.log(`Seeding ${process.env.NODE_ENV ?? 'development'} database…`);
  await seedVehicleTypesAndPricing();
  await seedExchangeRates();
  await seedPromoCodes();
  await seedRoles(await seedPermissions());
  await seedSuperAdmin();
  console.log('Done.');
}

await main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
