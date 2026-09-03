/**
 * Development helper: approves every pending driver and marks their required
 * documents as reviewed, so the matching flow can be exercised before the
 * admin dashboard exists. Refuses to run against production.
 *
 *   node scripts/approve-drivers.mjs
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

process.loadEnvFile(process.env.NODE_ENV === 'test' ? '.env.test' : '.env');

if (process.env.NODE_ENV === 'production') {
  throw new Error('approve-drivers is a development helper and will not run in production');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' }),
});

const REQUIRED = ['NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'DRIVER_LICENSE_FRONT', 'VEHICLE_REGISTRATION'];

const drivers = await prisma.driverProfile.findMany({
  where: { deletedAt: null },
  select: { id: true, fullName: true, userId: true },
});

for (const driver of drivers) {
  const file = await prisma.fileAsset.create({
    data: {
      bucket: 'deliver',
      objectKey: `dev-approval/${driver.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
      purpose: 'DRIVER_DOCUMENT',
      visibility: 'PRIVATE',
      mimeType: 'image/png',
      sizeBytes: 1,
      uploadedByUserId: driver.userId,
    },
    select: { id: true },
  });

  for (const type of REQUIRED) {
    await prisma.driverDocument.updateMany({
      where: { driverId: driver.id, type, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'EXPIRED' },
    });

    await prisma.driverDocument.create({
      data: { driverId: driver.id, type, fileId: file.id, status: 'APPROVED', reviewedAt: new Date() },
    });
  }

  await prisma.driverVehicle.updateMany({ where: { driverId: driver.id }, data: { status: 'APPROVED' } });
  await prisma.driverProfile.update({
    where: { id: driver.id },
    data: { approvalStatus: 'ACTIVE', approvedAt: new Date() },
  });

  console.log(`approved ${driver.fullName} (${driver.id})`);
}

console.log(`\n${drivers.length} driver(s) approved.`);
await prisma.$disconnect();
