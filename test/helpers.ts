import request from 'supertest';
import type { TestHarness } from './app-harness.js';
import { PERMISSION_CATALOGUE } from '../src/modules/admin/permissions.catalogue.js';
import { PasswordService } from '../src/modules/auth/services/password.service.js';

export const API = '/api/v1';

export interface ActivatedAccount {
  accessToken: string;
  refreshToken: string;
  userId: string;
  customerId: string | null;
  driverId: string | null;
  phone: string;
}

let phoneCounter = 0;

/** A phone number no other test in this file has used. */
export function nextPhone(): string {
  phoneCounter += 1;
  return `012${String(phoneCounter).padStart(6, '0')}`;
}

export function http(harness: TestHarness): request.Agent {
  return request(harness.app.getHttpServer() as Parameters<typeof request>[0]);
}

/**
 * Registers, verifies the OTP and sets a password — the shortest path to an
 * account a test can actually use. Rate-limit counters live in Redis and are
 * flushed by `harness.reset()`, so this is safe to call repeatedly.
 */
export async function activate(
  harness: TestHarness,
  role: 'CUSTOMER' | 'DRIVER' = 'CUSTOMER',
  phone = nextPhone(),
): Promise<ActivatedAccount> {
  const path = role === 'CUSTOMER' ? 'customer' : 'driver';
  const agent = http(harness);

  const registered = await agent
    .post(`${API}/auth/${path}/register`)
    .send({ phone, fullName: role === 'CUSTOMER' ? 'Sok Dara' : 'Chan Sopheak' })
    .expect(201);

  const verified = await agent
    .post(`${API}/auth/otp/verify`)
    .send({
      identifier: phone,
      channel: 'SMS',
      purpose: 'REGISTRATION',
      role,
      code: registered.body.data.otp.debugCode,
    })
    .expect(200);

  const session = await agent
    .post(`${API}/auth/${path}/set-password`)
    .send({ phone, verificationToken: verified.body.data.verificationToken, password: 'Passw0rd1' })
    .expect(200);

  return {
    accessToken: session.body.data.tokens.accessToken,
    refreshToken: session.body.data.tokens.refreshToken,
    userId: session.body.data.user.id,
    customerId: session.body.data.user.customerId,
    driverId: session.body.data.user.driverId,
    phone,
  };
}

/** An 8×8 teal PNG — small, and a genuinely valid image. */
export function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVQoz2NkYPjPQApgYhgFo2BwAcbRhAcAaOgBAcBTGvsAAAAASUVORK5CYII=',
    'base64',
  );
}

/** Bytes that are not any format we accept, whatever they are named. */
export function scriptFixture(): Buffer {
  return Buffer.from('<?php system($_GET["cmd"]); ?>\n'.repeat(4));
}

/**
 * A driver who can actually work: approved, documented, with a vehicle, and
 * online at a position. Everything the availability rules require, done the
 * way an admin and the driver app would do it.
 */
export async function readyDriver(
  harness: import('./app-harness.js').TestHarness,
  at: { latitude: number; longitude: number } = { latitude: 11.557, longitude: 104.929 },
  phone = nextPhone(),
): Promise<ActivatedAccount> {
  const driver = await activate(harness, 'DRIVER', phone);
  const driverId = driver.driverId as string;

  const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });

  await http(harness)
    .patch(`${API}/mobile/driver/vehicle`)
    .set({ Authorization: `Bearer ${driver.accessToken}` })
    .send({ vehicleTypeId: vehicleType.id, plateNumber: `${phone.slice(-6)}-X` })
    .expect(200);

  const file = await harness.prisma.fileAsset.create({
    data: {
      bucket: 'deliver',
      objectKey: `test-docs/${driverId}/${Date.now()}-${Math.random()}.png`,
      purpose: 'DRIVER_DOCUMENT',
      visibility: 'PRIVATE',
      mimeType: 'image/png',
      sizeBytes: 1,
      uploadedByUserId: driver.userId,
    },
    select: { id: true },
  });

  await harness.prisma.driverDocument.createMany({
    data: ['NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'DRIVER_LICENSE_FRONT', 'VEHICLE_REGISTRATION'].map((type) => ({
      driverId,
      type: type as 'NATIONAL_ID_FRONT',
      fileId: file.id,
      status: 'APPROVED' as const,
      reviewedAt: new Date(),
    })),
  });

  await harness.prisma.driverProfile.update({
    where: { id: driverId },
    data: { approvalStatus: 'ACTIVE', approvedAt: new Date() },
  });

  await http(harness)
    .put(`${API}/mobile/driver/availability`)
    .set({ Authorization: `Bearer ${driver.accessToken}` })
    .send({ status: 'ONLINE', ...at })
    .expect(200);

  return driver;
}

/** Runs a delivery all the way to DELIVERED so the driver actually gets paid. */
export async function completedDelivery(
  harness: import('./app-harness.js').TestHarness,
  customer: ActivatedAccount,
  driver: ActivatedAccount,
  vehicleTypeId: string,
  paymentMethod: 'CASH_ON_DELIVERY' | 'ABA_KHQR' = 'CASH_ON_DELIVERY',
): Promise<{
  deliveryId: string;
  bookingCode: string;
  netAmount: number;
  commissionAmount: number;
  totalAmount: number;
}> {
  const asCustomer = { Authorization: `Bearer ${customer.accessToken}` };
  const asDriver = { Authorization: `Bearer ${driver.accessToken}` };

  const booking = await http(harness)
    .post(`${API}/mobile/customer/deliveries`)
    .set(asCustomer)
    .send({
      pickup: {
        address: 'Independence Monument',
        latitude: 11.5564,
        longitude: 104.9282,
        contactName: 'Sok Dara',
        contactPhone: '012345678',
      },
      dropoff: {
        address: 'Chak Angrae',
        latitude: 11.5,
        longitude: 104.87,
        contactName: 'Chan Vuthy',
        contactPhone: '012999888',
      },
      vehicleTypeId,
      currency: 'KHR',
      packages: [{ size: 'SMALL', weightKg: 2 }],
      paymentMethod,
    })
    .expect(201);

  const deliveryId = booking.body.data.id as string;

  await harness.matching.runRound(deliveryId, 1);
  await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(asDriver).expect(200);

  for (const step of ['arrive-pickup', 'confirm-pickup', 'arrive-dropoff']) {
    await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/${step}`).set(asDriver).send({}).expect(200);
  }

  const upload = await http(harness)
    .post(`${API}/mobile/uploads`)
    .set(asDriver)
    .attach('file', pngFixture(), { filename: 'pod.png', contentType: 'image/png' })
    .field('purpose', 'PROOF_OF_DELIVERY')
    .expect(201);

  await http(harness)
    .post(`${API}/mobile/driver/jobs/${deliveryId}/proof-of-delivery`)
    .set(asDriver)
    .send({ photoFileId: upload.body.data.id })
    .expect(201);

  await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/complete`).set(asDriver).send({}).expect(200);

  const earning = await harness.prisma.driverEarning.findUniqueOrThrow({ where: { deliveryId } });

  return {
    deliveryId,
    bookingCode: booking.body.data.bookingCode as string,
    netAmount: earning.netAmount,
    commissionAmount: earning.commissionAmount,
    totalAmount: earning.deliveryAmount,
  };
}

export interface AdminAccount {
  accessToken: string;
  userId: string;
  adminId: string;
  phone: string;
}

/**
 * An operator holding exactly the permissions named — or everything, as a
 * super admin.
 *
 * Built through the database rather than an endpoint because the platform has
 * no admin self-registration: the first operator is bootstrapped by the seed,
 * and every one after that is created by another operator. Signing in still
 * goes through the real login endpoint, so the token is the same one the
 * dashboard would hold.
 */
export async function adminAccount(
  harness: TestHarness,
  permissions: string[] = ['admin.access'],
  options: { superAdmin?: boolean; phone?: string } = {},
): Promise<AdminAccount> {
  const phone = options.phone ?? nextPhone();
  const password = 'Passw0rd1';
  const passwordHash = await harness.app.get(PasswordService).hash(password);

  const user = await harness.prisma.user.create({
    data: {
      phone: `+855${phone.replace(/^0/, '')}`,
      role: 'ADMIN',
      status: 'ACTIVE',
      passwordHash,
      phoneVerifiedAt: new Date(),
    },
    select: { id: true },
  });

  // Truncation wipes the catalogue, so the rows this operator needs are put
  // back exactly as the seed would write them.
  const wanted = PERMISSION_CATALOGUE.filter((permission) => permissions.includes(permission.code));
  await harness.prisma.permission.createMany({ data: wanted, skipDuplicates: true });

  const stored = await harness.prisma.permission.findMany({
    where: { code: { in: permissions } },
    select: { id: true },
  });

  const role = await harness.prisma.role.create({
    data: {
      name: `Test role ${phone}`,
      slug: `test-role-${phone}`,
      permissions: { create: stored.map((permission) => ({ permissionId: permission.id })) },
    },
    select: { id: true },
  });

  const profile = await harness.prisma.adminProfile.create({
    data: {
      userId: user.id,
      fullName: 'Ops Operator',
      roleId: role.id,
      isSuperAdmin: options.superAdmin ?? false,
    },
    select: { id: true },
  });

  const session = await http(harness)
    .post(`${API}/auth/login`)
    .send({ phone, password, role: 'ADMIN' })
    .expect(200);

  return {
    accessToken: session.body.data.tokens.accessToken as string,
    userId: user.id,
    adminId: profile.id,
    phone,
  };
}
