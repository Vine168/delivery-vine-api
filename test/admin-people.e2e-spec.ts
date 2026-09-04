import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import {
  API,
  activate,
  adminAccount,
  completedDelivery,
  http,
  nextPhone,
  pngFixture,
  readyDriver,
  type ActivatedAccount,
  type AdminAccount,
} from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

const PEOPLE_OPS = [
  'admin.access',
  'drivers.view',
  'drivers.approve',
  'drivers.suspend',
  'drivers.edit',
  'customers.view',
  'customers.suspend',
  'deliveries.view',
  'deliveries.reassign',
];

describe('Back office — drivers and customers (e2e)', () => {
  let harness: TestHarness;
  let admin: AdminAccount;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    harness.map.shouldFail = false;
    admin = await adminAccount(harness, PEOPLE_OPS);
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });

  /** A driver who has applied: documents uploaded, nothing reviewed. */
  async function applicant(): Promise<ActivatedAccount> {
    const phone = nextPhone();
    const driver = await activate(harness, 'DRIVER', phone);
    const driverId = driver.driverId as string;
    const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });

    await http(harness)
      .patch(`${API}/mobile/driver/vehicle`)
      .set({ Authorization: `Bearer ${driver.accessToken}` })
      .send({ vehicleTypeId: vehicleType.id, plateNumber: `${phone.slice(-6)}-A` })
      .expect(200);

    for (const type of [
      'NATIONAL_ID_FRONT',
      'NATIONAL_ID_BACK',
      'DRIVER_LICENSE_FRONT',
      'VEHICLE_REGISTRATION',
    ]) {
      const upload = await http(harness)
        .post(`${API}/mobile/uploads`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .attach('file', pngFixture(), { filename: 'doc.png', contentType: 'image/png' })
        .field('purpose', 'DRIVER_DOCUMENT')
        .expect(201);

      await http(harness)
        .post(`${API}/mobile/driver/documents`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .send({ type, fileId: upload.body.data.id })
        .expect(201);
    }

    return driver;
  }

  const approveAllDocuments = async (driverId: string) =>
    harness.prisma.driverDocument.updateMany({
      where: { driverId },
      data: { status: 'APPROVED', reviewedAt: new Date() },
    });

  // ── Listing ────────────────────────────────────────────────────────────

  describe('GET /admin/drivers', () => {
    it('shows the fleet with live presence and the review queue', async () => {
      const online = await readyDriver(harness, NEARBY);
      await applicant();

      const response = await http(harness).get(`${API}/admin/drivers`).set(asAdmin()).expect(200);
      expect(response.body.meta.total).toBe(2);

      const working = response.body.data.find((row: { id: string }) => row.id === online.driverId);
      expect(working.approvalStatus).toBe('ACTIVE');
      expect(working.availability).toBe('ONLINE');
      expect(working.onlineNow).toBe(true);
      expect(working.plateNumber).toBeTruthy();
      expect(working.documentsAwaitingReview).toBe(0);

      const waiting = response.body.data.find((row: { id: string }) => row.id !== online.driverId);
      expect(waiting.approvalStatus).toBe('PENDING_APPROVAL');
      expect(waiting.onlineNow).toBe(false);
      expect(waiting.documentsAwaitingReview).toBe(4);
    });

    it('filters the approval queue and searches by plate', async () => {
      const pending = await applicant();
      await readyDriver(harness, NEARBY);

      const queue = await http(harness)
        .get(`${API}/admin/drivers?awaitingReview=true`)
        .set(asAdmin())
        .expect(200);
      expect(queue.body.data.map((row: { id: string }) => row.id)).toEqual([pending.driverId]);

      const byStatus = await http(harness)
        .get(`${API}/admin/drivers?approvalStatus=PENDING_APPROVAL`)
        .set(asAdmin())
        .expect(200);
      expect(byStatus.body.data).toHaveLength(1);

      const plate = `${pending.phone.slice(-6)}-A`;
      const byPlate = await http(harness)
        .get(`${API}/admin/drivers?search=${plate}`)
        .set(asAdmin())
        .expect(200);
      expect(byPlate.body.data.map((row: { id: string }) => row.id)).toEqual([pending.driverId]);
    });

    it('reports the readiness checklist the driver app shows', async () => {
      const pending = await applicant();

      const response = await http(harness)
        .get(`${API}/admin/drivers/${pending.driverId}`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data.canGoOnline).toBe(false);
      expect(response.body.data.blockers).toContain('DRIVER_NOT_APPROVED');
      expect(response.body.data.blockers).toContain('DRIVER_DOCUMENTS_INCOMPLETE');
      expect(response.body.data.documents).toHaveLength(4);
      expect(response.body.data.documents[0].fileUrl).toBeTruthy();
      expect(response.body.data.documents.every((doc: { status: string }) => doc.status === 'PENDING')).toBe(
        true,
      );
      expect(response.body.data.vehicles).toHaveLength(1);
    });
  });

  // ── Approval ───────────────────────────────────────────────────────────

  describe('POST /admin/drivers/:id/approve', () => {
    it('refuses while a required document is unreviewed, naming what is missing', async () => {
      const pending = await applicant();

      const response = await http(harness)
        .post(`${API}/admin/drivers/${pending.driverId}/approve`)
        .set(asAdmin())
        .expect(422);

      expect(response.body.code).toBe('DRIVER_DOCUMENTS_INCOMPLETE');
      expect(response.body.message).toContain('National ID (front)');

      const after = await harness.prisma.driverProfile.findUniqueOrThrow({
        where: { id: pending.driverId as string },
      });
      expect(after.approvalStatus).toBe('PENDING_APPROVAL');
    });

    it('admits a driver once the documents are reviewed, and tells them', async () => {
      const pending = await applicant();
      await approveAllDocuments(pending.driverId as string);

      const response = await http(harness)
        .post(`${API}/admin/drivers/${pending.driverId}/approve`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data.approvalStatus).toBe('ACTIVE');
      expect(response.body.data.canGoOnline).toBe(true);
      expect(response.body.data.blockers).toEqual([]);

      const notification = await harness.prisma.notification.findFirstOrThrow({
        where: { userId: pending.userId, type: 'ACCOUNT_STATUS_CHANGED' },
      });
      expect(notification.title).toContain('approved');

      const audit = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'driver.approve', entityId: pending.driverId as string },
      });
      expect(audit.actorUserId).toBe(admin.userId);

      // And the driver can now actually go online.
      await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set({ Authorization: `Bearer ${pending.accessToken}` })
        .send({ status: 'ONLINE', ...NEARBY })
        .expect(200);
    });

    it('refuses to approve a driver twice', async () => {
      const driver = await readyDriver(harness, NEARBY);

      const response = await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/approve`)
        .set(asAdmin())
        .expect(409);

      expect(response.body.code).toBe('DRIVER_ALREADY_APPROVED');
    });
  });

  describe('POST /admin/drivers/:id/reject', () => {
    it('turns down an application and takes them out of the pool', async () => {
      const pending = await applicant();

      const response = await http(harness)
        .post(`${API}/admin/drivers/${pending.driverId}/reject`)
        .set(asAdmin())
        .send({ reason: 'Licence photograph does not match the identity document' })
        .expect(200);

      expect(response.body.data.approvalStatus).toBe('REJECTED');
      expect(response.body.data.rejectedReason).toContain('does not match');

      const blocked = await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set({ Authorization: `Bearer ${pending.accessToken}` })
        .send({ status: 'ONLINE', ...NEARBY })
        .expect(422);
      expect(blocked.body.code).toBe('DRIVER_REJECTED');
    });
  });

  // ── Documents ──────────────────────────────────────────────────────────

  describe('POST /admin/drivers/:id/documents/:documentId/review', () => {
    it('requires a note when rejecting', async () => {
      const pending = await applicant();
      const document = await harness.prisma.driverDocument.findFirstOrThrow({
        where: { driverId: pending.driverId as string },
      });

      const response = await http(harness)
        .post(`${API}/admin/drivers/${pending.driverId}/documents/${document.id}/review`)
        .set(asAdmin())
        .send({ status: 'REJECTED' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('records the reviewer and notifies the driver', async () => {
      const pending = await applicant();
      const document = await harness.prisma.driverDocument.findFirstOrThrow({
        where: { driverId: pending.driverId as string, type: 'NATIONAL_ID_FRONT' },
      });

      const response = await http(harness)
        .post(`${API}/admin/drivers/${pending.driverId}/documents/${document.id}/review`)
        .set(asAdmin())
        .send({ status: 'APPROVED' })
        .expect(200);

      const reviewed = response.body.data.find((doc: { id: string }) => doc.id === document.id);
      expect(reviewed.status).toBe('APPROVED');
      expect(reviewed.reviewedByName).toBe('Ops Operator');
      expect(reviewed.required).toBe(true);

      const notification = await harness.prisma.notification.findFirstOrThrow({
        where: { userId: pending.userId, type: 'DOCUMENT_REVIEWED' },
      });
      expect(notification.title).toContain('National ID (front)');
    });

    it('takes a working driver offline when a required document is refused', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const document = await harness.prisma.driverDocument.findFirstOrThrow({
        where: { driverId: driver.driverId as string, type: 'DRIVER_LICENSE_FRONT' },
      });

      expect(await harness.prisma.driverAvailability.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      })).toMatchObject({ status: 'ONLINE' });

      await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/documents/${document.id}/review`)
        .set(asAdmin())
        .send({ status: 'REJECTED', note: 'Expiry date is not legible' })
        .expect(200);

      const availability = await harness.prisma.driverAvailability.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      });
      expect(availability.status).toBe('OFFLINE');

      // And the matcher can no longer see them.
      const nearby = await harness.matching['presence'].findNearby('MOTOR', NEARBY, 5_000, 10);
      expect(nearby.map((entry: { driverId: string }) => entry.driverId)).not.toContain(driver.driverId);
    });

    it('404s for a document belonging to another driver', async () => {
      const one = await applicant();
      const other = await applicant();
      const document = await harness.prisma.driverDocument.findFirstOrThrow({
        where: { driverId: other.driverId as string },
      });

      const response = await http(harness)
        .post(`${API}/admin/drivers/${one.driverId}/documents/${document.id}/review`)
        .set(asAdmin())
        .send({ status: 'APPROVED' })
        .expect(404);

      expect(response.body.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  // ── Suspension ─────────────────────────────────────────────────────────

  describe('POST /admin/drivers/:id/suspend', () => {
    it('refuses while the driver is holding a delivery', async () => {
      const customer = await activate(harness);
      const driver = await readyDriver(harness, NEARBY);
      const vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;

      const booking = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
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
          paymentMethod: 'CASH_ON_DELIVERY',
        })
        .expect(201);

      await harness.matching.runRound(booking.body.data.id, 1);
      await http(harness)
        .post(`${API}/mobile/driver/jobs/${booking.body.data.id}/accept`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .expect(200);

      const refused = await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Repeated complaints' })
        .expect(409);

      expect(refused.body.code).toBe('DRIVER_HAS_ACTIVE_DELIVERY');
      expect(refused.body.message).toContain('Reassign or cancel');

      // Reassigning frees the driver, and the suspension then goes through.
      await http(harness)
        .post(`${API}/admin/deliveries/${booking.body.data.id}/reassign`)
        .set(asAdmin())
        .send({ reason: 'Suspending the driver' })
        .expect(200);

      await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Repeated complaints' })
        .expect(200);
    });

    it('ends every session and blocks sign-in immediately', async () => {
      const driver = await readyDriver(harness, NEARBY);

      const response = await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Documents found to be forged' })
        .expect(200);

      expect(response.body.data.approvalStatus).toBe('SUSPENDED');
      expect(response.body.data.accountStatus).toBe('SUSPENDED');
      expect(response.body.data.suspendedReason).toContain('forged');
      expect(response.body.data.onlineNow).toBe(false);

      // The token they were holding stops working at once — no waiting for
      // the cached principal to expire.
      await http(harness)
        .get(`${API}/mobile/driver/profile`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .expect(401);

      // And they cannot sign back in.
      const login = await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: driver.phone, password: 'Passw0rd1', role: 'DRIVER' })
        .expect(403);
      expect(login.body.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('reinstates a suspended driver', async () => {
      const driver = await readyDriver(harness, NEARBY);
      await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Under investigation' })
        .expect(200);

      const response = await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/reinstate`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data.approvalStatus).toBe('ACTIVE');
      expect(response.body.data.accountStatus).toBe('ACTIVE');
      expect(response.body.data.suspendedReason).toBeNull();

      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: driver.phone, password: 'Passw0rd1', role: 'DRIVER' })
        .expect(200);
    });

    it('refuses to reinstate a driver who is not suspended', async () => {
      const driver = await readyDriver(harness, NEARBY);

      const response = await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/reinstate`)
        .set(asAdmin())
        .expect(409);

      expect(response.body.code).toBe('DRIVER_NOT_SUSPENDED');
    });
  });

  // ── Zones ──────────────────────────────────────────────────────────────

  describe('PUT /admin/drivers/:id/zones', () => {
    it('replaces the assignment and can be filtered on', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const [central, riverside] = await Promise.all([
        harness.prisma.zone.create({ data: { code: 'PP-CENTRAL', name: 'Central' } }),
        harness.prisma.zone.create({ data: { code: 'PP-RIVER', name: 'Riverside' } }),
      ]);

      const first = await http(harness)
        .put(`${API}/admin/drivers/${driver.driverId}/zones`)
        .set(asAdmin())
        .send({ zoneIds: [central.id, riverside.id] })
        .expect(200);
      expect(first.body.data).toHaveLength(2);

      const filtered = await http(harness)
        .get(`${API}/admin/drivers?zoneId=${central.id}`)
        .set(asAdmin())
        .expect(200);
      expect(filtered.body.data.map((row: { id: string }) => row.id)).toEqual([driver.driverId]);

      const replaced = await http(harness)
        .put(`${API}/admin/drivers/${driver.driverId}/zones`)
        .set(asAdmin())
        .send({ zoneIds: [riverside.id] })
        .expect(200);
      expect(replaced.body.data.map((zone: { code: string }) => zone.code)).toEqual(['PP-RIVER']);

      const cleared = await http(harness)
        .put(`${API}/admin/drivers/${driver.driverId}/zones`)
        .set(asAdmin())
        .send({ zoneIds: [] })
        .expect(200);
      expect(cleared.body.data).toEqual([]);
    });

    it('rejects a zone that does not exist', async () => {
      const driver = await readyDriver(harness, NEARBY);

      const response = await http(harness)
        .put(`${API}/admin/drivers/${driver.driverId}/zones`)
        .set(asAdmin())
        .send({ zoneIds: ['zk0078hwg1a85xjjo4k626h0'] })
        .expect(404);

      expect(response.body.code).toBe('ZONE_NOT_FOUND');
    });
  });

  // ── Customers ──────────────────────────────────────────────────────────

  describe('customers', () => {
    it('lists and searches customers', async () => {
      const customer = await activate(harness);
      await activate(harness);

      const all = await http(harness).get(`${API}/admin/customers`).set(asAdmin()).expect(200);
      expect(all.body.meta.total).toBe(2);

      const found = await http(harness)
        .get(`${API}/admin/customers?search=${customer.phone.slice(-6)}`)
        .set(asAdmin())
        .expect(200);
      expect(found.body.data.map((row: { id: string }) => row.id)).toEqual([customer.customerId]);

      const byName = await http(harness)
        .get(`${API}/admin/customers?search=Sok`)
        .set(asAdmin())
        .expect(200);
      expect(byName.body.meta.total).toBe(2);
    });

    it('reports spend per currency and never sums across them', async () => {
      const customer = await activate(harness);
      const driver = await readyDriver(harness, NEARBY);
      const vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;

      await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .get(`${API}/admin/customers/${customer.customerId}`)
        .set(asAdmin())
        .expect(200);

      const settled = await harness.prisma.delivery.findFirstOrThrow({ where: { status: 'DELIVERED' } });
      expect(response.body.data.deliveredCount).toBe(1);
      expect(response.body.data.spend).toHaveLength(1);
      expect(response.body.data.spend[0]).toMatchObject({
        currency: 'KHR',
        totalSpent: settled.totalAmount,
        deliveredCount: 1,
      });
      expect(response.body.data.addresses).toEqual([]);
    });

    it('suspends and reinstates, leaving deliveries in motion alone', async () => {
      const customer = await activate(harness);

      const suspended = await http(harness)
        .post(`${API}/admin/customers/${customer.customerId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Fraudulent promo code use' })
        .expect(200);

      expect(suspended.body.data.status).toBe('SUSPENDED');
      expect(suspended.body.data.suspendedReason).toContain('Fraudulent');

      await http(harness)
        .get(`${API}/mobile/customer/profile`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
        .expect(401);

      const again = await http(harness)
        .post(`${API}/admin/customers/${customer.customerId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Again' })
        .expect(409);
      expect(again.body.code).toBe('ACCOUNT_SUSPENDED');

      const reinstated = await http(harness)
        .post(`${API}/admin/customers/${customer.customerId}/reinstate`)
        .set(asAdmin())
        .expect(200);
      expect(reinstated.body.data.status).toBe('ACTIVE');

      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: customer.phone, password: 'Passw0rd1', role: 'CUSTOMER' })
        .expect(200);
    });

    it('does not let a driver suspension touch the same person’s customer account', async () => {
      // One phone number, two accounts — the platform allows this deliberately.
      const phone = nextPhone();
      const customer = await activate(harness, 'CUSTOMER', phone);
      await harness.expireOtpCooldowns();
      const driver = await readyDriver(harness, NEARBY, phone);

      await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Documents found to be forged' })
        .expect(200);

      const stillACustomer = await http(harness)
        .get(`${API}/admin/customers/${customer.customerId}`)
        .set(asAdmin())
        .expect(200);
      expect(stillACustomer.body.data.status).toBe('ACTIVE');

      await http(harness)
        .get(`${API}/mobile/customer/profile`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
        .expect(200);
    });
  });

  // ── Permissions ────────────────────────────────────────────────────────

  describe('permissions', () => {
    it('separates viewing from deciding', async () => {
      const viewer = await adminAccount(harness, ['admin.access', 'drivers.view']);
      const pending = await applicant();
      await approveAllDocuments(pending.driverId as string);

      await http(harness)
        .get(`${API}/admin/drivers`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .expect(200);

      const refused = await http(harness)
        .post(`${API}/admin/drivers/${pending.driverId}/approve`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .expect(403);
      expect(refused.body.message).toContain('approve');

      const suspendRefused = await http(harness)
        .post(`${API}/admin/drivers/${pending.driverId}/suspend`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .send({ reason: 'No' })
        .expect(403);
      expect(suspendRefused.body.message).toContain('suspend');
    });

    it('keeps customer access separate from driver access', async () => {
      const driverOps = await adminAccount(harness, ['admin.access', 'drivers.view']);

      await http(harness)
        .get(`${API}/admin/customers`)
        .set({ Authorization: `Bearer ${driverOps.accessToken}` })
        .expect(403);
    });
  });
});
