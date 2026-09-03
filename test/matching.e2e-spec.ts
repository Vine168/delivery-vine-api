import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, readyDriver, type ActivatedAccount } from './helpers.js';

const PICKUP = {
  address: 'Independence Monument, Phnom Penh',
  latitude: 11.5564,
  longitude: 104.9282,
  contactName: 'Sok Dara',
  contactPhone: '012345678',
};

const DROPOFF = {
  address: 'Chak Angrae Leu, Phnom Penh',
  latitude: 11.5,
  longitude: 104.87,
  contactName: 'Chan Sopheak',
  contactPhone: '012999888',
};

/** Around the corner from the pickup. */
const NEARBY = { latitude: 11.557, longitude: 104.929 };
/** Far enough to fall outside the first round's radius. */
const FAR = { latitude: 11.75, longitude: 105.15 };

describe('Availability, presence and matching (e2e)', () => {
  let harness: TestHarness;
  let customer: ActivatedAccount;
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
    customer = await activate(harness);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const bearer = (account: ActivatedAccount) => ({ Authorization: `Bearer ${account.accessToken}` });

  async function book(): Promise<{ id: string; bookingCode: string }> {
    const response = await http(harness)
      .post(`${API}/mobile/customer/deliveries`)
      .set(bearer(customer))
      .send({
        pickup: PICKUP,
        dropoff: DROPOFF,
        vehicleTypeId,
        currency: 'KHR',
        packages: [{ size: 'SMALL', weightKg: 2 }],
        paymentMethod: 'CASH_ON_DELIVERY',
      })
      .expect(201);

    return { id: response.body.data.id, bookingCode: response.body.data.bookingCode };
  }

  describe('going online', () => {
    it('refuses an unapproved driver', async () => {
      const driver = await activate(harness, 'DRIVER');

      const response = await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set(bearer(driver))
        .send({ status: 'ONLINE' })
        .expect(422);

      expect(response.body.code).toBe('DRIVER_NOT_APPROVED');
    });

    it('refuses an approved driver with no vehicle', async () => {
      const driver = await activate(harness, 'DRIVER');
      await harness.prisma.driverProfile.update({
        where: { id: driver.driverId as string },
        data: { approvalStatus: 'ACTIVE' },
      });

      const response = await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set(bearer(driver))
        .send({ status: 'ONLINE' })
        .expect(422);

      expect(['DRIVER_VEHICLE_REQUIRED', 'DRIVER_DOCUMENTS_INCOMPLETE']).toContain(response.body.code);
    });

    it('lets a fully onboarded driver go online and start an online session', async () => {
      const driver = await readyDriver(harness);

      const availability = await http(harness)
        .get(`${API}/mobile/driver/availability`)
        .set(bearer(driver))
        .expect(200);

      expect(availability.body.data.status).toBe('ONLINE');
      expect(availability.body.data.onlineSinceAt).toBeTruthy();

      const sessions = await harness.prisma.driverOnlineSession.findMany({
        where: { driverId: driver.driverId as string },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].endedAt).toBeNull();
    });

    it('refuses BUSY as a client-supplied status', async () => {
      const driver = await readyDriver(harness);

      const response = await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set(bearer(driver))
        .send({ status: 'BUSY' })
        .expect(400);

      expect(response.body.errors[0].message).toContain('ONLINE or OFFLINE');
    });

    it('closes the online session and clears presence when going offline', async () => {
      const driver = await readyDriver(harness);

      await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set(bearer(driver))
        .send({ status: 'OFFLINE' })
        .expect(200);

      const session = await harness.prisma.driverOnlineSession.findFirstOrThrow({
        where: { driverId: driver.driverId as string },
      });
      expect(session.endedAt).not.toBeNull();
      expect(session.durationSeconds).toBeGreaterThanOrEqual(0);

      const nearby = await http(harness)
        .get(`${API}/mobile/customer/drivers/nearby?latitude=11.5564&longitude=104.9282`)
        .set(bearer(customer))
        .expect(200);
      expect(nearby.body.data).toHaveLength(0);
    });
  });

  describe('location reporting', () => {
    it('refuses a fix from an offline driver', async () => {
      const driver = await activate(harness, 'DRIVER');

      const response = await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(bearer(driver))
        .send({ latitude: 11.5564, longitude: 104.9282 })
        .expect(422);

      expect(response.body.code).toBe('DRIVER_NOT_ONLINE');
    });

    it('accepts a fix without writing to the database when there is no delivery', async () => {
      const driver = await readyDriver(harness);

      const response = await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(bearer(driver))
        .send({ latitude: 11.5575, longitude: 104.9295, heading: 180, speed: 8.3, accuracy: 5 })
        .expect(200);

      expect(response.body.data).toMatchObject({ accepted: true, recorded: false, deliveryId: null });
      expect(await harness.prisma.deliveryTrackPoint.count()).toBe(0);
    });

    it('rejects impossible coordinates', async () => {
      const driver = await readyDriver(harness);

      const response = await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(bearer(driver))
        .send({ latitude: 200, longitude: 104.9282 })
        .expect(400);

      expect(response.body.errors[0].field).toBe('latitude');
    });
  });

  describe('nearby drivers', () => {
    it('shows a pin with no identifying information', async () => {
      await readyDriver(harness, NEARBY);

      const response = await http(harness)
        .get(`${API}/mobile/customer/drivers/nearby?latitude=11.5564&longitude=104.9282`)
        .set(bearer(customer))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(Object.keys(response.body.data[0]).sort()).toEqual([
        'distanceMeters',
        'heading',
        'latitude',
        'longitude',
        'vehicleTypeCode',
      ]);
    });

    it('excludes drivers outside the radius', async () => {
      await readyDriver(harness, FAR);

      const response = await http(harness)
        .get(`${API}/mobile/customer/drivers/nearby?latitude=11.5564&longitude=104.9282&radiusMeters=2000`)
        .set(bearer(customer))
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });
  });

  describe('dispatching', () => {
    it('offers the job to nearby drivers with a real distance and earning', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();

      const result = await harness.matching.runRound(delivery.id, 1);

      expect(result.offersMade).toBe(1);

      const offers = await http(harness)
        .get(`${API}/mobile/driver/jobs/requests`)
        .set(bearer(driver))
        .expect(200);

      expect(offers.body.data).toHaveLength(1);
      expect(offers.body.data[0]).toMatchObject({
        bookingCode: delivery.bookingCode,
        status: 'SEARCHING_DRIVER',
        accepted: false,
      });
      expect(offers.body.data[0].estimatedEarningAmount).toBeGreaterThan(0);
      expect(offers.body.data[0].distanceToPickupMeters).toBeGreaterThan(0);
    });

    it('withholds the customer’s details until the job is accepted', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();
      await harness.matching.runRound(delivery.id, 1);

      const before = await http(harness).get(`${API}/mobile/driver/jobs/requests`).set(bearer(driver)).expect(200);
      const offer = before.body.data[0];

      expect(offer.pickup.contactName).toBeNull();
      expect(offer.pickup.contactPhone).toMatch(/\*\*\*/);
      expect(offer.customerName).toBe('Sok'); // first name only

      const accepted = await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/accept`)
        .set(bearer(driver))
        .expect(200);

      expect(accepted.body.data.pickup.contactName).toBe('Sok Dara');
      expect(accepted.body.data.pickup.contactPhone).toBe('+85512345678');
      expect(accepted.body.data.customerName).toBe('Sok Dara');
    });

    it('does not offer to a driver who is offline or out of range', async () => {
      await readyDriver(harness, FAR);
      const offline = await activate(harness, 'DRIVER');
      await harness.prisma.driverProfile.update({
        where: { id: offline.driverId as string },
        data: { approvalStatus: 'ACTIVE' },
      });

      const delivery = await book();
      const result = await harness.matching.runRound(delivery.id, 1);

      expect(result.offersMade).toBe(0);
    });

    it('widens the radius on later rounds', async () => {
      await readyDriver(harness, { latitude: 11.6, longitude: 104.99 }); // ~9 km out
      const delivery = await book();

      const first = await harness.matching.runRound(delivery.id, 1);
      expect(first.offersMade).toBe(0);

      const second = await harness.matching.runRound(delivery.id, 2);
      expect(second.radiusMeters).toBeGreaterThan(first.radiusMeters);
      expect(second.offersMade).toBe(1);
    });

    it('never offers the same delivery twice to a driver who declined it', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();
      await harness.matching.runRound(delivery.id, 1);

      await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/decline`)
        .set(bearer(driver))
        .send({ reason: 'Too far' })
        .expect(204);

      const second = await harness.matching.runRound(delivery.id, 2);
      expect(second.offersMade).toBe(0);
    });

    it('gives a driver whose offer merely lapsed another chance', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();
      await harness.matching.runRound(delivery.id, 1);

      // The offer window closes with no answer.
      await harness.matching.expireRound(delivery.id, 1);

      const second = await harness.matching.runRound(delivery.id, 2);
      expect(second.offersMade).toBe(1);

      const requests = await http(harness).get(`${API}/mobile/driver/jobs/requests`).set(bearer(driver)).expect(200);
      expect(requests.body.data).toHaveLength(1);
    });

    it('does not offer to a driver who is already on a job', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const first = await book();
      await harness.matching.runRound(first.id, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${first.id}/accept`).set(bearer(driver)).expect(200);

      const second = await book();
      const result = await harness.matching.runRound(second.id, 1);

      expect(result.offersMade).toBe(0);
    });

    it('expires the delivery when nobody takes it', async () => {
      const delivery = await book();

      const expired = await harness.matching.expireSearch(delivery.id);
      expect(expired).toBe(true);

      const row = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.status).toBe('EXPIRED');

      const history = await harness.prisma.deliveryStatusHistory.findFirst({
        where: { deliveryId: delivery.id, toStatus: 'EXPIRED' },
      });
      expect(history?.actorType).toBe('SYSTEM');
    });

    it('withdraws outstanding offers when the customer cancels', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();
      await harness.matching.runRound(delivery.id, 1);

      await http(harness)
        .post(`${API}/mobile/customer/deliveries/${delivery.id}/cancel`)
        .set(bearer(customer))
        .send({ reason: 'Changed my mind' })
        .expect(200);

      await harness.matching.cancelOutstandingOffers(delivery.id);

      const requests = await http(harness).get(`${API}/mobile/driver/jobs/requests`).set(bearer(driver)).expect(200);
      expect(requests.body.data).toHaveLength(0);
    });
  });

  describe('accepting a job', () => {
    it('assigns the delivery, records the transition and marks the driver busy', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();
      await harness.matching.runRound(delivery.id, 1);

      const response = await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/accept`)
        .set(bearer(driver))
        .expect(200);

      expect(response.body.code).toBe('JOB_ACCEPTED');
      expect(response.body.data.accepted).toBe(true);

      const row = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.status).toBe('DRIVER_ASSIGNED');
      expect(row.driverId).toBe(driver.driverId);
      expect(row.assignedAt).not.toBeNull();

      const availability = await harness.prisma.driverAvailability.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      });
      expect(availability.status).toBe('BUSY');

      const history = await harness.prisma.deliveryStatusHistory.findFirst({
        where: { deliveryId: delivery.id, toStatus: 'DRIVER_ASSIGNED' },
      });
      expect(history?.actorType).toBe('DRIVER');
    });

    it('refuses a delivery that was never offered to this driver', async () => {
      const offered = await readyDriver(harness, NEARBY);
      const outsider = await readyDriver(harness, NEARBY);
      const delivery = await book();

      // Offer to the first driver only.
      await harness.prisma.deliveryAssignment.create({
        data: {
          deliveryId: delivery.id,
          driverId: offered.driverId as string,
          round: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const response = await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/accept`)
        .set(bearer(outsider))
        .expect(404);

      expect(response.body.code).toBe('JOB_NOT_FOUND');
    });

    it('refuses an offer that has already lapsed', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();

      await harness.prisma.deliveryAssignment.create({
        data: {
          deliveryId: delivery.id,
          driverId: driver.driverId as string,
          round: 1,
          expiresAt: new Date(Date.now() - 1_000),
        },
      });

      const response = await http(harness)
        .post(`${API}/mobile/driver/jobs/${delivery.id}/accept`)
        .set(bearer(driver))
        .expect(409);

      expect(response.body.code).toBe('JOB_OFFER_EXPIRED');
    });

    it('refuses a second job while one is in flight', async () => {
      const driver = await readyDriver(harness, NEARBY);

      const first = await book();
      await harness.matching.runRound(first.id, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${first.id}/accept`).set(bearer(driver)).expect(200);

      const second = await book();
      await harness.prisma.deliveryAssignment.create({
        data: {
          deliveryId: second.id,
          driverId: driver.driverId as string,
          round: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const response = await http(harness)
        .post(`${API}/mobile/driver/jobs/${second.id}/accept`)
        .set(bearer(driver))
        .expect(409);

      expect(response.body.code).toBe('DRIVER_HAS_ACTIVE_DELIVERY');
    });

    it('refuses to let a driver go offline mid-delivery', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();
      await harness.matching.runRound(delivery.id, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${delivery.id}/accept`).set(bearer(driver)).expect(200);

      const response = await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set(bearer(driver))
        .send({ status: 'OFFLINE' })
        .expect(409);

      expect(response.body.code).toBe('DRIVER_HAS_ACTIVE_DELIVERY');
    });
  });

  describe('the accept race', () => {
    it('lets exactly one of five simultaneous drivers win', async () => {
      const drivers = await Promise.all([
        readyDriver(harness, NEARBY),
        readyDriver(harness, NEARBY),
        readyDriver(harness, NEARBY),
        readyDriver(harness, NEARBY),
        readyDriver(harness, NEARBY),
      ]);

      const delivery = await book();
      const round = await harness.matching.runRound(delivery.id, 1);
      expect(round.offersMade).toBe(5);

      // Fired together, resolved together — no ordering imposed by the test.
      const responses = await Promise.all(
        drivers.map((driver) =>
          http(harness).post(`${API}/mobile/driver/jobs/${delivery.id}/accept`).set(bearer(driver)).send(),
        ),
      );

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(4);

      for (const response of responses.filter((r) => r.status === 409)) {
        expect(response.body.code).toBe('DELIVERY_ALREADY_ASSIGNED');
        expect(response.body.message).toBe('This delivery has already been assigned to another driver.');
      }

      // The database agrees: one winner, one assignment, everyone else cancelled.
      const row = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.status).toBe('DRIVER_ASSIGNED');
      expect(row.driverId).not.toBeNull();

      const assignments = await harness.prisma.deliveryAssignment.groupBy({
        by: ['status'],
        where: { deliveryId: delivery.id },
        _count: { _all: true },
      });

      const byStatus = Object.fromEntries(assignments.map((row) => [row.status, row._count._all]));
      expect(byStatus.ACCEPTED).toBe(1);
      expect(byStatus.CANCELLED).toBe(4);

      // Exactly one transition into DRIVER_ASSIGNED — no double-writes.
      const transitions = await harness.prisma.deliveryStatusHistory.count({
        where: { deliveryId: delivery.id, toStatus: 'DRIVER_ASSIGNED' },
      });
      expect(transitions).toBe(1);

      // And only the winner is busy.
      const busy = await harness.prisma.driverAvailability.count({ where: { status: 'BUSY' } });
      expect(busy).toBe(1);
    });

    it('never lets two deliveries land on one driver', async () => {
      const driver = await readyDriver(harness, NEARBY);

      const first = await book();
      const second = await book();

      for (const delivery of [first, second]) {
        await harness.prisma.deliveryAssignment.create({
          data: {
            deliveryId: delivery.id,
            driverId: driver.driverId as string,
            round: 1,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
      }

      const responses = await Promise.all(
        [first, second].map((delivery) =>
          http(harness).post(`${API}/mobile/driver/jobs/${delivery.id}/accept`).set(bearer(driver)).send(),
        ),
      );

      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);

      const assigned = await harness.prisma.delivery.count({
        where: { driverId: driver.driverId as string, status: 'DRIVER_ASSIGNED' },
      });
      expect(assigned).toBe(1);
    });
  });

  describe('dashboard', () => {
    it('aggregates the home screen in one call', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await book();
      await harness.matching.runRound(delivery.id, 1);

      const response = await http(harness).get(`${API}/mobile/driver/dashboard`).set(bearer(driver)).expect(200);
      const { data } = response.body;

      expect(data.availability).toBe('ONLINE');
      expect(data.canGoOnline).toBe(true);
      expect(data.blockers).toEqual([]);
      expect(data.counts.newRequests).toBe(1);
      expect(data.counts.ongoing).toBe(0);
      expect(data.earnings).toMatchObject({ today: 0, thisWeek: 0, currency: 'KHR' });

      await http(harness).post(`${API}/mobile/driver/jobs/${delivery.id}/accept`).set(bearer(driver)).expect(200);

      const after = await http(harness).get(`${API}/mobile/driver/dashboard`).set(bearer(driver)).expect(200);
      expect(after.body.data.availability).toBe('BUSY');
      expect(after.body.data.counts.ongoing).toBe(1);
      expect(after.body.data.counts.newRequests).toBe(0);
      expect(after.body.data.acceptanceRate).toBe(1);
    });
  });
});
