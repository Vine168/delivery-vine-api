import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import {
  API,
  activate,
  adminAccount,
  completedDelivery,
  http,
  readyDriver,
  type ActivatedAccount,
  type AdminAccount,
} from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

const OPERATIONS = [
  'admin.access',
  'dashboard.view',
  'deliveries.view',
  'deliveries.cancel',
  'deliveries.reassign',
];

describe('Back office — dashboard and deliveries (e2e)', () => {
  let harness: TestHarness;
  let admin: AdminAccount;
  let customer: ActivatedAccount;
  let driver: ActivatedAccount;
  let vehicleTypeId: string;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    harness.map.shouldFail = false;
    admin = await adminAccount(harness, OPERATIONS);
    customer = await activate(harness);
    driver = await readyDriver(harness, NEARBY);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customer.accessToken}` });
  const asDriver = () => ({ Authorization: `Bearer ${driver.accessToken}` });

  /** Books a delivery and leaves it looking for a driver. */
  async function book(): Promise<{ id: string; bookingCode: string }> {
    const response = await http(harness)
      .post(`${API}/mobile/customer/deliveries`)
      .set(asCustomer())
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

    return { id: response.body.data.id, bookingCode: response.body.data.bookingCode };
  }

  /** Books, dispatches and has the driver accept — a job in progress. */
  async function assigned(): Promise<{ id: string; bookingCode: string }> {
    const delivery = await book();
    await harness.matching.runRound(delivery.id, 1);
    await http(harness).post(`${API}/mobile/driver/jobs/${delivery.id}/accept`).set(asDriver()).expect(200);
    return delivery;
  }

  // ── Access ─────────────────────────────────────────────────────────────

  describe('access', () => {
    it('refuses a customer token', async () => {
      const response = await http(harness).get(`${API}/admin/deliveries`).set(asCustomer()).expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('ROLE_NOT_ALLOWED');
    });

    it('refuses an operator who lacks the permission, naming what is missing', async () => {
      const support = await adminAccount(harness, ['admin.access', 'deliveries.view']);
      const delivery = await book();

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.id}/cancel`)
        .set({ Authorization: `Bearer ${support.accessToken}` })
        .send({ reason: 'Customer called' })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.message).toContain('cancel');

      // And the delivery is untouched.
      const after = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after.status).toBe('SEARCHING_DRIVER');
    });

    it('refuses an unauthenticated caller', async () => {
      await http(harness).get(`${API}/admin/dashboard`).expect(401);
    });
  });

  // ── Dashboard ──────────────────────────────────────────────────────────

  describe('GET /admin/dashboard', () => {
    it('reports volumes, revenue per currency and a gapless trend', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      await book();

      const response = await http(harness).get(`${API}/admin/dashboard`).set(asAdmin()).expect(200);
      const data = response.body.data;

      expect(data.deliveries.total).toBe(2);
      expect(data.deliveries.delivered).toBe(1);
      expect(data.deliveries.searching).toBe(1);
      expect(data.deliveries.active).toBe(1);
      // One delivered, nothing finished unsuccessfully.
      expect(data.deliveries.completionRateBps).toBe(10_000);

      // Reported straight from what was settled — never recomputed from
      // today's pricing rules.
      const settled = await harness.prisma.delivery.findFirstOrThrow({ where: { status: 'DELIVERED' } });
      expect(data.revenue).toHaveLength(1);
      expect(data.revenue[0].currency).toBe('KHR');
      expect(data.revenue[0].deliveredCount).toBe(1);
      expect(data.revenue[0].grossAmount).toBe(settled.totalAmount);
      expect(data.revenue[0].commissionAmount).toBe(settled.commissionAmount);
      expect(data.revenue[0].driverEarningAmount).toBe(settled.driverEarningAmount);
      expect(data.revenue[0].averageOrderValue).toBe(settled.totalAmount);

      expect(data.drivers.total).toBe(1);
      expect(data.drivers.active).toBe(1);
      expect(data.customers.total).toBe(1);
      expect(data.customers.orderedInRange).toBe(1);

      // Fourteen days by default, every one of them present.
      expect(data.trend).toHaveLength(14);
      expect(data.trend.at(-1).date).toBe(data.dateTo);
      expect(data.timezone).toBeTruthy();

      const today = data.trend.at(-1);
      expect(today.deliveries).toBe(2);
      expect(today.delivered).toBe(1);
      expect(today.revenue[0].currency).toBe('KHR');
    });

    it('never sums money across currencies', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      // Restate the settled delivery in USD, as a dual-currency platform will
      // genuinely have.
      await harness.prisma.delivery.updateMany({
        where: { status: 'DELIVERED' },
        data: { currency: 'USD' },
      });

      const secondCustomer = await activate(harness);
      const secondDriver = await readyDriver(harness, NEARBY);
      await completedDelivery(harness, secondCustomer, secondDriver, vehicleTypeId);

      const response = await http(harness).get(`${API}/admin/dashboard`).set(asAdmin()).expect(200);
      const currencies = response.body.data.revenue.map((entry: { currency: string }) => entry.currency).sort();

      expect(currencies).toEqual(['KHR', 'USD']);
      expect(response.body.data.revenue).toHaveLength(2);
    });

    it('counts what is waiting on an operator', async () => {
      const pending = await activate(harness, 'DRIVER');
      await harness.prisma.driverProfile.update({
        where: { id: pending.driverId as string },
        data: { approvalStatus: 'PENDING_APPROVAL' },
      });

      const delivery = await book();
      await harness.prisma.delivery.update({
        where: { id: delivery.id },
        data: { confirmedAt: new Date(Date.now() - 20 * 60_000) },
      });

      const response = await http(harness).get(`${API}/admin/dashboard`).set(asAdmin()).expect(200);

      expect(response.body.data.attention.driverApprovals).toBe(1);
      expect(response.body.data.attention.stalledDeliveries).toBe(1);
    });
  });

  // ── Listing ────────────────────────────────────────────────────────────

  describe('GET /admin/deliveries', () => {
    it('shows the platform split that the customer view hides', async () => {
      const { deliveryId } = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const [operator, own] = await Promise.all([
        http(harness).get(`${API}/admin/deliveries`).set(asAdmin()).expect(200),
        http(harness).get(`${API}/mobile/customer/deliveries/${deliveryId}`).set(asCustomer()).expect(200),
      ]);

      const row = operator.body.data.find((item: { id: string }) => item.id === deliveryId);
      expect(row.commissionAmount).toBeGreaterThan(0);
      expect(row.driverEarningAmount).toBeGreaterThan(0);
      expect(row.customer.phone).toBe(customer.phone.replace(/^0/, '+855'));
      expect(row.driver.fullName).toBe('Chan Sopheak');

      // The customer's own copy of the same delivery zeroes the split.
      expect(own.body.data.price.commissionAmount).toBe(0);
      expect(own.body.data.price.driverEarningAmount).toBe(0);
      expect(row.commissionAmount).toBeGreaterThan(0);
    });

    it('filters by status and searches by booking code and phone', async () => {
      const searching = await book();
      const done = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const byStatus = await http(harness)
        .get(`${API}/admin/deliveries?status=DELIVERED`)
        .set(asAdmin())
        .expect(200);
      expect(byStatus.body.data.map((row: { id: string }) => row.id)).toEqual([done.deliveryId]);

      const byCode = await http(harness)
        .get(`${API}/admin/deliveries?search=${searching.bookingCode}`)
        .set(asAdmin())
        .expect(200);
      expect(byCode.body.data).toHaveLength(1);
      expect(byCode.body.data[0].id).toBe(searching.id);

      const byPhone = await http(harness)
        .get(`${API}/admin/deliveries?search=${driver.phone.slice(-6)}`)
        .set(asAdmin())
        .expect(200);
      expect(byPhone.body.data.map((row: { id: string }) => row.id)).toEqual([done.deliveryId]);
    });

    it('finds deliveries that have been searching too long', async () => {
      const stalled = await book();
      await book();
      await harness.prisma.delivery.update({
        where: { id: stalled.id },
        data: { confirmedAt: new Date(Date.now() - 30 * 60_000) },
      });

      const response = await http(harness)
        .get(`${API}/admin/deliveries?stalledForMinutes=10`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(stalled.id);
      expect(response.body.data[0].waitingMinutes).toBeGreaterThanOrEqual(30);
    });
  });

  // ── Detail and timeline ────────────────────────────────────────────────

  describe('GET /admin/deliveries/:id', () => {
    it('returns the dispatch trail alongside the delivery', async () => {
      const delivery = await assigned();

      const response = await http(harness)
        .get(`${API}/admin/deliveries/${delivery.id}`)
        .set(asAdmin())
        .expect(200);

      const data = response.body.data;
      expect(data.bookingCode).toBe(delivery.bookingCode);
      expect(data.price.commissionAmount).toBeGreaterThan(0);
      expect(data.packages).toHaveLength(1);

      expect(data.offers).toHaveLength(1);
      expect(data.offers[0].driverId).toBe(driver.driverId);
      expect(data.offers[0].status).toBe('ACCEPTED');
      expect(data.offers[0].round).toBe(1);

      expect(data.timeline.map((entry: { toStatus: string }) => entry.toStatus)).toEqual([
        'SEARCHING_DRIVER',
        'DRIVER_ASSIGNED',
      ]);
    });

    it('404s for an id that does not exist', async () => {
      const response = await http(harness)
        .get(`${API}/admin/deliveries/zk0078hwg1a85xjjo4k626h0`)
        .set(asAdmin())
        .expect(404);

      expect(response.body.code).toBe('DELIVERY_NOT_FOUND');
    });

    it('names the actor behind each status change', async () => {
      const delivery = await assigned();

      const response = await http(harness)
        .get(`${API}/admin/deliveries/${delivery.id}/timeline`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data[0].actorType).toBe('CUSTOMER');
      expect(response.body.data[0].actorName).toBe('Sok Dara');
      expect(response.body.data[1].actorType).toBe('DRIVER');
      expect(response.body.data[1].actorName).toBe('Chan Sopheak');
    });
  });

  // ── Cancel ─────────────────────────────────────────────────────────────

  describe('POST /admin/deliveries/:id/cancel', () => {
    it('cancels after pickup, which the customer cannot do', async () => {
      const delivery = await assigned();
      await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/arrive-pickup`)
        .set(asDriver())
        .send({})
        .expect(200);
      await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/confirm-pickup`)
        .set(asDriver())
        .send({})
        .expect(200);

      // The customer is refused at this point: the state machine says only
      // an operator may cancel a delivery whose package is already collected.
      await http(harness)
        .post(`${API}/mobile/customer/deliveries/${delivery.id}/cancel`)
        .set(asCustomer())
        .send({ reason: 'Changed my mind' })
        .expect(403);

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.id}/cancel`)
        .set(asAdmin())
        .send({ reason: 'Recipient unreachable, customer agreed on the phone' })
        .expect(200);

      expect(response.body.data.status).toBe('CANCELLED');
      expect(response.body.data.cancelledByType).toBe('ADMIN');
      expect(response.body.data.cancelReason).toContain('Recipient unreachable');

      const audit = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'delivery.cancel', entityId: delivery.id },
      });
      expect(audit.actorUserId).toBe(admin.userId);
      expect(audit.summary).toContain(delivery.bookingCode);
      expect((audit.after as { status: string }).status).toBe('CANCELLED');
    });

    it('refuses to cancel a delivery that is already finished', async () => {
      const { deliveryId } = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${deliveryId}/cancel`)
        .set(asAdmin())
        .send({ reason: 'Too late' })
        .expect(409);

      expect(response.body.code).toBe('DELIVERY_ALREADY_COMPLETED');
    });

    it('requires a reason', async () => {
      const delivery = await book();

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.id}/cancel`)
        .set(asAdmin())
        .send({})
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── Reassign ───────────────────────────────────────────────────────────

  describe('POST /admin/deliveries/:id/reassign', () => {
    it('returns the job to the pool, frees the driver and keeps the booking', async () => {
      const delivery = await assigned();

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.id}/reassign`)
        .set(asAdmin())
        .send({ reason: 'Driver unreachable for 15 minutes' })
        .expect(200);

      expect(response.body.data.status).toBe('SEARCHING_DRIVER');
      expect(response.body.data.driver).toBeNull();

      const availability = await harness.prisma.driverAvailability.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      });
      expect(availability.status).toBe('ONLINE');

      // The released driver is not offered the same job again.
      const offer = await harness.prisma.deliveryAssignment.findFirstOrThrow({
        where: { deliveryId: delivery.id, driverId: driver.driverId as string },
      });
      expect(offer.status).toBe('DECLINED');

      const round = await harness.matching.runRound(delivery.id, 2);
      expect(round.offersMade).toBe(0);

      // A different driver can still take it.
      const replacement = await readyDriver(harness, NEARBY);
      const second = await harness.matching.runRound(delivery.id, 3);
      expect(second.offersMade).toBe(1);

      await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/accept`)
        .set({ Authorization: `Bearer ${replacement.accessToken}` })
        .expect(200);

      const finished = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(finished.status).toBe('DRIVER_ASSIGNED');
      expect(finished.driverId).toBe(replacement.driverId);
    });

    it('refuses once the driver has the package', async () => {
      const delivery = await assigned();
      for (const step of ['arrive-pickup', 'confirm-pickup']) {
        await http(harness)
          .post(`${API}/mobile/driver/jobs/${delivery.id}/${step}`)
          .set(asDriver())
          .send({})
          .expect(200);
      }

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.id}/reassign`)
        .set(asAdmin())
        .send({ reason: 'Driver went quiet' })
        .expect(422);

      expect(response.body.code).toBe('DELIVERY_NOT_REASSIGNABLE');
      expect(response.body.message).toContain('Cancel the delivery instead');
    });

    it('refuses a delivery that has no driver yet', async () => {
      const delivery = await book();

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.id}/reassign`)
        .set(asAdmin())
        .send({ reason: 'Nobody has taken it' })
        .expect(422);

      expect(response.body.code).toBe('DELIVERY_NOT_REASSIGNABLE');
    });
  });

  // ── Live map ───────────────────────────────────────────────────────────

  describe('GET /admin/deliveries/live', () => {
    it('lists what is in motion with the driver’s last known position', async () => {
      const delivery = await assigned();
      await completedDelivery(harness, customer, await readyDriver(harness, NEARBY), vehicleTypeId);

      const response = await http(harness).get(`${API}/admin/deliveries/live`).set(asAdmin()).expect(200);

      expect(response.body.data).toHaveLength(1);
      const live = response.body.data[0];
      expect(live.id).toBe(delivery.id);
      expect(live.driverName).toBe('Chan Sopheak');
      expect(live.driverLatitude).toBeCloseTo(NEARBY.latitude, 3);
      expect(live.driverLongitude).toBeCloseTo(NEARBY.longitude, 3);
    });
  });
});
