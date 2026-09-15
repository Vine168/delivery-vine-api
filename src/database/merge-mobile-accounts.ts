import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PrismaService } from './prisma.service.js';
import { UserRole, UserStatus } from '../generated/prisma/enums.js';

/**
 * Merges the old per-role accounts into one mobile account per phone number.
 *
 * The platform used to give a person one `User` row per role, so someone who
 * both ordered and drove held two accounts with two passwords. A mobile
 * account is now a single row that may carry a customer profile, a driver
 * profile, or both. This brings existing data to that shape.
 *
 * The customer row survives, with its password: it is the one people use most
 * and the one they are most likely to remember. A customer sign-up that was
 * never finished has no password, and then the driver's comes across instead.
 * The driver row's profile and everything hanging off it — the wallet above
 * all — is re-pointed onto the survivor before that row is deleted, because
 * `Wallet` cascades from `User` and deleting first would destroy balances.
 *
 * Back-office accounts are left alone. An operator login stays a separate
 * account on purpose.
 *
 * Safe to run more than once: an already-merged phone has nothing left to do.
 * Pass `--apply` to write; the default reports what it would change.
 */
const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);

  const mobile = await prisma.user.findMany({
    where: { role: { in: [UserRole.CUSTOMER, UserRole.DRIVER] } },
    select: {
      id: true,
      phone: true,
      role: true,
      status: true,
      passwordHash: true,
      phoneVerifiedAt: true,
      customerProfile: { select: { id: true, fullName: true } },
      driverProfile: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const byPhone = new Map<string, typeof mobile>();
  for (const user of mobile) {
    byPhone.set(user.phone, [...(byPhone.get(user.phone) ?? []), user]);
  }

  let merged = 0;
  let converted = 0;

  for (const [phone, rows] of byPhone) {
    const customer = rows.find((r) => r.role === UserRole.CUSTOMER);
    const driver = rows.find((r) => r.role === UserRole.DRIVER);

    // ── Both roles on one number: fold the driver row into the customer one ──
    if (customer && driver) {
      console.log(`merge  ${phone}  driver ${driver.id} → customer ${customer.id}`);
      merged += 1;
      if (!APPLY) continue;

      await prisma.$transaction(async (tx) => {
        // The profile itself, and then everything keyed by the old user id.
        await tx.driverProfile.update({ where: { userId: driver.id }, data: { userId: customer.id } });
        await tx.wallet.updateMany({ where: { userId: driver.id }, data: { userId: customer.id } });
        await tx.notification.updateMany({ where: { userId: driver.id }, data: { userId: customer.id } });
        await tx.device.updateMany({ where: { userId: driver.id }, data: { userId: customer.id } });
        await tx.message.updateMany({ where: { senderUserId: driver.id }, data: { senderUserId: customer.id } });
        await tx.fileAsset.updateMany({
          where: { uploadedByUserId: driver.id },
          data: { uploadedByUserId: customer.id },
        });
        await tx.deliveryStatusHistory.updateMany({
          where: { actorUserId: driver.id },
          data: { actorUserId: customer.id },
        });

        // A person cannot be in the same conversation twice, so any row that
        // would collide with one the customer already holds is dropped rather
        // than moved.
        const held = await tx.conversationParticipant.findMany({
          where: { userId: customer.id },
          select: { conversationId: true },
        });
        const heldIds = held.map((row) => row.conversationId);
        await tx.conversationParticipant.deleteMany({
          where: { userId: driver.id, conversationId: { in: heldIds } },
        });
        await tx.conversationParticipant.updateMany({
          where: { userId: driver.id },
          data: { userId: customer.id },
        });

        // Sessions and keys are not worth carrying: the driver signs in again
        // with the customer password, which is the point of the merge.
        await tx.refreshToken.deleteMany({ where: { userId: driver.id } });
        await tx.userSession.deleteMany({ where: { userId: driver.id } });
        await tx.idempotencyKey.deleteMany({ where: { userId: driver.id } });

        await tx.user.delete({ where: { id: driver.id } });

        // A driver-only row may have been the active one. The survivor then
        // takes its password and verification as well — an unfinished
        // customer sign-up has neither, and a working driver would otherwise
        // be told to finish setting up an account they have used for months.
        if (customer.status === UserStatus.PENDING_VERIFICATION && driver.status === UserStatus.ACTIVE) {
          await tx.user.update({
            where: { id: customer.id },
            data: {
              status: UserStatus.ACTIVE,
              passwordHash: driver.passwordHash,
              phoneVerifiedAt: driver.phoneVerifiedAt,
            },
          });
        }
      });
      continue;
    }

    // ── Driver-only: becomes a mobile account that can also order ──────────
    if (driver && !customer) {
      console.log(`convert ${phone}  driver-only ${driver.id} → mobile account`);
      converted += 1;
      if (!APPLY) continue;

      await prisma.user.update({
        where: { id: driver.id },
        data: {
          role: UserRole.CUSTOMER,
          customerProfile: { create: { fullName: driver.driverProfile?.fullName ?? '' } },
        },
      });
    }
  }

  // The migration adds User_role_not_driver NOT VALID so it could ship before
  // this ran: rows written since were checked, older ones were not. With
  // nothing left to merge it can hold for every row.
  if (APPLY) {
    const remaining = await prisma.user.count({ where: { role: UserRole.DRIVER } });
    if (remaining === 0) {
      await prisma.$executeRaw`ALTER TABLE "User" VALIDATE CONSTRAINT "User_role_not_driver"`;
      console.log('validated User_role_not_driver');
    } else {
      console.log(`${remaining} DRIVER row(s) remain; User_role_not_driver left unvalidated`);
    }
  }

  console.log(
    `\n${APPLY ? 'applied' : 'dry run'}: ${merged} merge(s), ${converted} conversion(s) across ${byPhone.size} phone number(s)`,
  );
  if (!APPLY) console.log('re-run with --apply to write');

  await app.close();
}

await main();
