import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PrismaService } from './prisma.service.js';
import { PasswordService } from '../modules/auth/services/password.service.js';
import {
  DocumentReviewStatus,
  DriverApprovalStatus,
  DriverDocumentType,
  UserRole,
  UserStatus,
} from '../generated/prisma/enums.js';
import { REQUIRED_DRIVER_DOCUMENTS } from '../modules/drivers/driver.constants.js';

/**
 * Accounts for trying the API by hand.
 *
 * Written straight to the database rather than through registration, because
 * registration now sends a real SMS: these are invented numbers, so a real
 * flow would either cost a message or reach a stranger who never asked for
 * one. Everything that matters still goes through the application's own
 * services — the same password hashing, and a driver who satisfies the real
 * readiness rules rather than one waved past them.
 *
 * Safe to run repeatedly, and refuses to run in production, where an account
 * with a published password would be a back door.
 */
const PASSWORD = 'Passw0rd!23';
const CUSTOMER_PHONE = '+85511111111';
const DRIVER_PHONE = '+85522222222';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to create accounts with a known password in production.');
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const passwordHash = await app.get(PasswordService).hash(PASSWORD);

  const upsertUser = (phone: string, role: UserRole) =>
    prisma.user.upsert({
      where: { phone_role: { phone, role } },
      create: {
        phone,
        role,
        status: UserStatus.ACTIVE,
        passwordHash,
        // Vouched for by whoever ran this, so there is no OTP step to pass.
        phoneVerifiedAt: new Date(),
      },
      update: { status: UserStatus.ACTIVE, passwordHash, suspendedReason: null },
      select: { id: true },
    });

  // ── Customer ──────────────────────────────────────────────────────────
  const customerUser = await upsertUser(CUSTOMER_PHONE, UserRole.CUSTOMER);
  await prisma.customerProfile.upsert({
    where: { userId: customerUser.id },
    create: { userId: customerUser.id, fullName: 'Test Customer' },
    update: { fullName: 'Test Customer' },
  });

  // ── Driver, ready to work ─────────────────────────────────────────────
  // A driver is a mobile account with a driver profile on it: sign-in only
  // looks up CUSTOMER-role accounts now, so a DRIVER-role row cannot log in.
  // A database seeded before the merge has that row; converting it in place
  // keeps a re-run from leaving this number with two accounts.
  await prisma.user.updateMany({
    where: { phone: DRIVER_PHONE, role: UserRole.DRIVER },
    data: { role: UserRole.CUSTOMER },
  });
  const driverUser = await upsertUser(DRIVER_PHONE, UserRole.CUSTOMER);
  await prisma.customerProfile.upsert({
    where: { userId: driverUser.id },
    create: { userId: driverUser.id, fullName: 'Test Driver' },
    update: {},
  });
  const driver = await prisma.driverProfile.upsert({
    where: { userId: driverUser.id },
    create: {
      userId: driverUser.id,
      fullName: 'Test Driver',
      approvalStatus: DriverApprovalStatus.ACTIVE,
      approvedAt: new Date(),
    },
    update: {
      approvalStatus: DriverApprovalStatus.ACTIVE,
      approvedAt: new Date(),
      suspendedReason: null,
      rejectedReason: null,
    },
    select: { id: true },
  });

  const vehicleType = await prisma.vehicleType.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, code: true },
  });

  const vehicle = await prisma.driverVehicle.findFirst({
    where: { driverId: driver.id, deletedAt: null },
    select: { id: true },
  });

  if (!vehicle) {
    await prisma.driverVehicle.create({
      data: {
        driverId: driver.id,
        vehicleTypeId: vehicleType.id,
        plateNumber: 'TEST-0001',
        isPrimary: true,
        status: DocumentReviewStatus.APPROVED,
      },
    });
  }

  // A driver cannot go online until every required document is approved, so
  // the seeded one carries them rather than bypassing the check.
  const placeholder =
    (await prisma.fileAsset.findFirst({ where: { objectKey: 'seed/test-driver-document.png' } })) ??
    (await prisma.fileAsset.create({
      data: {
        bucket: process.env.STORAGE_BUCKET ?? 'deliver',
        objectKey: 'seed/test-driver-document.png',
        purpose: 'DRIVER_DOCUMENT',
        visibility: 'PRIVATE',
        mimeType: 'image/png',
        sizeBytes: 1,
        uploadedByUserId: driverUser.id,
      },
    }));

  for (const type of REQUIRED_DRIVER_DOCUMENTS) {
    const existing = await prisma.driverDocument.findFirst({
      where: { driverId: driver.id, type },
      select: { id: true },
    });

    if (existing) {
      await prisma.driverDocument.update({
        where: { id: existing.id },
        data: { status: DocumentReviewStatus.APPROVED, reviewedAt: new Date() },
      });
    } else {
      await prisma.driverDocument.create({
        data: {
          driverId: driver.id,
          type: type as DriverDocumentType,
          fileId: placeholder.id,
          status: DocumentReviewStatus.APPROVED,
          reviewedAt: new Date(),
        },
      });
    }
  }

  console.log('Test accounts ready — password for both:', PASSWORD);
  console.log(`  CUSTOMER  ${CUSTOMER_PHONE}  Test Customer`);
  console.log(`  DRIVER    ${DRIVER_PHONE}  Test Driver (${vehicleType.code}, TEST-0001, approved)`);

  await app.close();
}

await main().catch((error: unknown) => {
  console.error('Could not create the test accounts:', error);
  process.exit(1);
});
