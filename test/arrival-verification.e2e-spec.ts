import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, adminAccount, http, readyDriver, type ActivatedAccount } from './helpers.js';

const PICKUP = { latitude: 11.5564, longitude: 104.9282 };
const DROPOFF = { latitude: 11.5, longitude: 104.87 };
/** Where the driver goes online: a couple of streets from the pickup. */
const NEARBY = { latitude: 11.557, longitude: 104.929 };
/** Sihanoukville, some 200 km away. */
const FAR_AWAY = { latitude: 10.6, longitude: 103.53 };

/**
 * The state machine enforces the order of a delivery but said nothing about
 * where it happened, so a driver could accept a prepaid job and walk it
 * through every step without leaving home.
 */
describe('Arrival verification (e2e)', () => {
  let harness: TestHarness;
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
    customer = await activate(harness);
    driver = await readyDriver(harness, NEARBY);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const asDriver = () => ({ Authorization: `Bearer ${driver.accessToken}` });

  async function assignedDelivery(): Promise<string> {
    const booking = await http(harness)
      .post(`${API}/mobile/customer/deliveries`)
      .set({ Authorization: `Bearer ${customer.accessToken}` })
      .send({
        pickup: { address: 'Independence Monument', ...PICKUP, contactName: 'Sok Dara', contactPhone: '012345678' },
        dropoff: { address: 'Chak Angrae', ...DROPOFF, contactName: 'Chan Vuthy', contactPhone: '012999888' },
        vehicleTypeId,
        currency: 'KHR',
        packages: [{ size: 'SMALL', weightKg: 2 }],
        paymentMethod: 'ABA_KHQR',
      })
      .expect(201);

    const deliveryId = booking.body.data.id as string;
    await harness.matching.runRound(deliveryId, 1);
    await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(asDriver()).expect(200);
    return deliveryId;
  }

  const step = (deliveryId: string, name: string) =>
    http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/${name}`).set(asDriver());

  describe('claiming an arrival from somewhere else', () => {
    it('is refused at the pickup, and says how far off the driver is', async () => {
      const deliveryId = await assignedDelivery();

      const response = await step(deliveryId, 'arrive-pickup').send(FAR_AWAY).expect(422);

      expect(response.body.code).toBe('DRIVER_TOO_FAR_AWAY');
      expect(response.body.message).toMatch(/You are about \d+ m away/);
      expect(response.body.message).toContain('300 m');

      const delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery.status).toBe('DRIVER_ASSIGNED');
    });

    it('is refused at the drop-off, so a job cannot be completed from home', async () => {
      const deliveryId = await assignedDelivery();
      await step(deliveryId, 'arrive-pickup').send(PICKUP).expect(200);
      await step(deliveryId, 'confirm-pickup').send(PICKUP).expect(200);

      // Still standing at the pickup, claiming to have delivered it.
      const response = await step(deliveryId, 'arrive-dropoff').send(PICKUP).expect(422);
      expect(response.body.code).toBe('DRIVER_TOO_FAR_AWAY');

      // And completion is gated behind arrival, so the driver is not paid.
      await step(deliveryId, 'complete').send({}).expect(422);
      expect(await harness.prisma.driverEarning.count()).toBe(0);
    });

    it('falls back to the live position when the request carries none', async () => {
      const deliveryId = await assignedDelivery();

      // An app that sends no coordinates is still pushing them to the presence
      // stream, so the server has a position either way. The driver went
      // online beside the pickup, so collecting is allowed…
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);

      // …and claiming the drop-off without having moved is not.
      const refused = await step(deliveryId, 'arrive-dropoff').send({}).expect(422);
      expect(refused.body.code).toBe('DRIVER_TOO_FAR_AWAY');
    });
  });

  describe('an honest delivery', () => {
    it('goes through, and records where each step happened', async () => {
      const deliveryId = await assignedDelivery();

      await step(deliveryId, 'arrive-pickup').send(PICKUP).expect(200);
      await step(deliveryId, 'confirm-pickup').send(PICKUP).expect(200);
      await step(deliveryId, 'arrive-dropoff').send(DROPOFF).expect(200);

      const history = await harness.prisma.deliveryStatusHistory.findMany({
        where: { deliveryId, toStatus: { in: ['ARRIVED_PICKUP', 'ARRIVED_DROPOFF'] } },
      });

      expect(history).toHaveLength(2);
      for (const entry of history) {
        // A dispute months later can be answered with where the driver was.
        expect(entry.metadata).toMatchObject({ verified: true });
        expect((entry.metadata as { distanceMeters: number }).distanceMeters).toBeLessThanOrEqual(300);
      }
    });

    it('accepts a position that is close but not exact', async () => {
      const deliveryId = await assignedDelivery();

      // Roughly 100 m from the pickup — ordinary GPS drift in a city.
      await step(deliveryId, 'arrive-pickup')
        .send({ latitude: PICKUP.latitude + 0.0009, longitude: PICKUP.longitude })
        .expect(200);
    });
  });

  describe('the radius', () => {
    it('is an operator setting, not a constant', async () => {
      const admin = await adminAccount(harness, ['admin.access', 'settings.view', 'settings.manage']);
      const deliveryId = await assignedDelivery();

      // A city with poor GPS: widen the circle rather than strand drivers.
      await http(harness)
        .put(`${API}/admin/settings/delivery.arrivalRadiusMeters`)
        .set({ Authorization: `Bearer ${admin.accessToken}` })
        .send({ value: 5_000 })
        .expect(200);

      await step(deliveryId, 'arrive-pickup')
        .send({ latitude: PICKUP.latitude + 0.02, longitude: PICKUP.longitude })
        .expect(200);
    });
  });
});
