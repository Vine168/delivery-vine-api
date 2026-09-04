import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, pngFixture, readyDriver, type ActivatedAccount } from './helpers.js';

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
  contactName: 'Chan Vuthy',
  contactPhone: '012999888',
};

const NEARBY = { latitude: 11.557, longitude: 104.929 };

describe('Delivery execution (e2e)', () => {
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

  const asCustomer = () => ({ Authorization: `Bearer ${customer.accessToken}` });
  const asDriver = () => ({ Authorization: `Bearer ${driver.accessToken}` });

  async function book(cod?: { amount: number }): Promise<string> {
    const response = await http(harness)
      .post(`${API}/mobile/customer/deliveries`)
      .set(asCustomer())
      .send({
        pickup: PICKUP,
        dropoff: DROPOFF,
        vehicleTypeId,
        currency: 'KHR',
        packages: [{ size: 'MEDIUM', weightKg: 6 }],
        paymentMethod: 'CASH_ON_DELIVERY',
        ...(cod ? { cod: { enabled: true, amount: cod.amount, payer: 'RECIPIENT' } } : {}),
      })
      .expect(201);

    return response.body.data.id;
  }

  async function accepted(cod?: { amount: number }): Promise<string> {
    const deliveryId = await book(cod);
    await harness.matching.runRound(deliveryId, 1);
    await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(asDriver()).expect(200);
    return deliveryId;
  }

  const step = (deliveryId: string, name: string) =>
    http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/${name}`).set(asDriver());

  async function attachProof(): Promise<string> {
    const upload = await http(harness)
      .post(`${API}/mobile/uploads`)
      .set(asDriver())
      .attach('file', pngFixture(), { filename: 'pod.png', contentType: 'image/png' })
      .field('purpose', 'PROOF_OF_DELIVERY')
      .expect(201);

    return upload.body.data.id;
  }

  describe('the ordered steps', () => {
    it('walks a delivery from assignment to delivered', async () => {
      const deliveryId = await accepted();

      await step(deliveryId, 'arrive-pickup').send({ latitude: PICKUP.latitude, longitude: PICKUP.longitude }).expect(200);
      await step(deliveryId, 'confirm-pickup').send({ note: 'One box' }).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);

      const photoFileId = await attachProof();
      await step(deliveryId, 'proof-of-delivery')
        .send({ photoFileId, recipientName: 'Chan Vuthy' })
        .expect(201);

      await step(deliveryId, 'complete').send({}).expect(200);

      const delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery.status).toBe('DELIVERED');
      expect(delivery.deliveredAt).not.toBeNull();
      expect(delivery.arrivedPickupAt).not.toBeNull();
      expect(delivery.pickedUpAt).not.toBeNull();
      expect(delivery.arrivedDropoffAt).not.toBeNull();
    });

    it('records every transition with the actor who made it', async () => {
      const deliveryId = await accepted();

      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);
      const photoFileId = await attachProof();
      await step(deliveryId, 'proof-of-delivery').send({ photoFileId }).expect(201);
      await step(deliveryId, 'complete').send({}).expect(200);

      const history = await harness.prisma.deliveryStatusHistory.findMany({
        where: { deliveryId },
        orderBy: { createdAt: 'asc' },
        select: { fromStatus: true, toStatus: true, actorType: true },
      });

      expect(history.map((entry) => entry.toStatus)).toEqual([
        'SEARCHING_DRIVER',
        'DRIVER_ASSIGNED',
        'ARRIVED_PICKUP',
        'PICKED_UP',
        'ARRIVED_DROPOFF',
        'DELIVERED',
      ]);
      expect(history[0].actorType).toBe('CUSTOMER');
      expect(history.slice(1).every((entry) => entry.actorType === 'DRIVER')).toBe(true);
    });

    it('refuses steps taken out of order', async () => {
      const deliveryId = await accepted();

      const early = await step(deliveryId, 'confirm-pickup').send({}).expect(422);
      expect(early.body.code).toBe('DELIVERY_INVALID_TRANSITION');

      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(422);

      // And a step cannot be replayed.
      await step(deliveryId, 'arrive-pickup').send({}).expect(422);
    });

    it('lets a driver who drove straight there skip IN_TRANSIT', async () => {
      const deliveryId = await accepted();

      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);

      const delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery.status).toBe('ARRIVED_DROPOFF');
      expect(delivery.inTransitAt).toBeNull();
    });

    it('will not let another driver touch the job', async () => {
      const deliveryId = await accepted();
      const stranger = await readyDriver(harness, NEARBY);

      const response = await http(harness)
        .post(`${API}/mobile/driver/jobs/${deliveryId}/arrive-pickup`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .send({})
        .expect(404);

      expect(response.body.code).toBe('DELIVERY_NOT_ASSIGNED');
    });
  });

  describe('in transit', () => {
    it('is set by the location stream, not by a button', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);

      // Still at the pickup: nothing changes.
      await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(asDriver())
        .send({ latitude: PICKUP.latitude, longitude: PICKUP.longitude })
        .expect(200);

      let delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery.status).toBe('PICKED_UP');

      // Now well away from it.
      await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(asDriver())
        .send({ latitude: 11.53, longitude: 104.9 })
        .expect(200);

      delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery.status).toBe('IN_TRANSIT');

      const history = await harness.prisma.deliveryStatusHistory.findFirst({
        where: { deliveryId, toStatus: 'IN_TRANSIT' },
      });
      expect(history?.actorType).toBe('SYSTEM');
    });

    it('writes breadcrumbs only while a delivery is in flight, and only on a throttle', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);

      const first = await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(asDriver())
        .send({ latitude: 11.55, longitude: 104.92 })
        .expect(200);
      expect(first.body.data.recorded).toBe(true);

      const second = await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(asDriver())
        .send({ latitude: 11.549, longitude: 104.919 })
        .expect(200);
      expect(second.body.data.recorded).toBe(false); // swallowed by the throttle

      expect(await harness.prisma.deliveryTrackPoint.count({ where: { deliveryId } })).toBe(1);
    });
  });

  describe('proof of delivery', () => {
    it('is required before completing', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);

      const response = await step(deliveryId, 'complete').send({}).expect(422);
      expect(response.body.code).toBe('PROOF_OF_DELIVERY_REQUIRED');
    });

    it('stores the photo privately and records who received the package', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);

      const photoFileId = await attachProof();
      const response = await step(deliveryId, 'proof-of-delivery')
        .send({ photoFileId, recipientName: 'Chan Vuthy', note: 'Left with reception', latitude: 11.5, longitude: 104.87 })
        .expect(201);

      expect(response.body.data.photoUrl).toContain('X-Amz-Signature');
      expect(response.body.data.recipientName).toBe('Chan Vuthy');

      const recipient = await harness.prisma.deliveryRecipient.findUniqueOrThrow({ where: { deliveryId } });
      expect(recipient.receivedByName).toBe('Chan Vuthy');
    });

    it('lets a blurred photo be retaken', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);

      const first = await attachProof();
      await step(deliveryId, 'proof-of-delivery').send({ photoFileId: first }).expect(201);

      const second = await attachProof();
      await step(deliveryId, 'proof-of-delivery').send({ photoFileId: second }).expect(201);

      expect(await harness.prisma.proofOfDelivery.count({ where: { deliveryId } })).toBe(1);

      const proof = await harness.prisma.proofOfDelivery.findUniqueOrThrow({ where: { deliveryId } });
      expect(proof.photoFileId).toBe(second);

      // The replaced photo is removed rather than left orphaned.
      const discarded = await harness.prisma.fileAsset.findUniqueOrThrow({ where: { id: first } });
      expect(discarded.deletedAt).not.toBeNull();
    });

    it('refuses a photo belonging to someone else', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);

      const other = await readyDriver(harness, NEARBY);
      const theirUpload = await http(harness)
        .post(`${API}/mobile/uploads`)
        .set({ Authorization: `Bearer ${other.accessToken}` })
        .attach('file', pngFixture(), { filename: 'pod.png', contentType: 'image/png' })
        .field('purpose', 'PROOF_OF_DELIVERY')
        .expect(201);

      const response = await step(deliveryId, 'proof-of-delivery')
        .send({ photoFileId: theirUpload.body.data.id })
        .expect(400);

      expect(response.body.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('completing', () => {
    async function readyToComplete(cod?: { amount: number }): Promise<string> {
      const deliveryId = await accepted(cod);
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);
      const photoFileId = await attachProof();
      await step(deliveryId, 'proof-of-delivery').send({ photoFileId }).expect(201);
      return deliveryId;
    }

    it('writes an immutable earning snapshot', async () => {
      const deliveryId = await readyToComplete();
      await step(deliveryId, 'complete').send({}).expect(200);

      const delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      const earning = await harness.prisma.driverEarning.findUniqueOrThrow({ where: { deliveryId } });

      expect(earning.deliveryAmount).toBe(delivery.totalAmount);
      expect(earning.commissionAmount).toBe(delivery.commissionAmount);
      expect(earning.netAmount).toBe(delivery.driverEarningAmount);
      expect(earning.currency).toBe(delivery.currency);
      // A cash booking: the driver was handed the fare at the door, so the
      // earning is already PAID and the ledger entry is the commission charged
      // back to them rather than a credit.
      expect(earning.status).toBe('PAID');
      expect(earning.cashCollectedAmount).toBe(delivery.totalAmount);
      expect(earning.walletTransactionId).toBeTruthy();

      // Changing today's rules cannot rewrite yesterday's pay.
      await harness.prisma.pricingRule.updateMany({ data: { commissionPercentBp: 9_000 } });
      const unchanged = await harness.prisma.driverEarning.findUniqueOrThrow({ where: { deliveryId } });
      expect(unchanged.commissionAmount).toBe(earning.commissionAmount);
      expect(unchanged.netAmount).toBe(earning.netAmount);
    });

    it('frees the driver and updates their counters', async () => {
      const deliveryId = await readyToComplete();

      const busy = await harness.prisma.driverAvailability.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      });
      expect(busy.status).toBe('BUSY');

      await step(deliveryId, 'complete').send({}).expect(200);

      const free = await harness.prisma.driverAvailability.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      });
      expect(free.status).toBe('ONLINE');

      const profile = await harness.prisma.driverProfile.findUniqueOrThrow({
        where: { id: driver.driverId as string },
      });
      expect(profile.completedDeliveries).toBe(1);

      const assignment = await harness.prisma.deliveryAssignment.findFirstOrThrow({ where: { deliveryId } });
      expect(assignment.status).toBe('COMPLETED');
    });

    it('settles a cash delivery only when the amount matches', async () => {
      const deliveryId = await readyToComplete({ amount: 40_000 });

      const missing = await step(deliveryId, 'complete').send({}).expect(400);
      expect(missing.body.errors[0].field).toBe('codCollectedAmount');

      const wrong = await step(deliveryId, 'complete').send({ codCollectedAmount: 35_000 }).expect(422);
      expect(wrong.body.message).toContain('40000');

      await step(deliveryId, 'complete').send({ codCollectedAmount: 40_000 }).expect(200);

      const delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery.paymentStatus).toBe('PAID');
      expect(delivery.codCollectedAt).not.toBeNull();
    });

    it('cannot be completed twice', async () => {
      const deliveryId = await readyToComplete();
      await step(deliveryId, 'complete').send({}).expect(200);
      await step(deliveryId, 'complete').send({}).expect(422);

      expect(await harness.prisma.driverEarning.count({ where: { deliveryId } })).toBe(1);
    });
  });

  describe('handing a job back', () => {
    it('returns the delivery to the pool rather than cancelling the customer’s booking', async () => {
      const deliveryId = await accepted();

      await step(deliveryId, 'cancel').send({ reason: 'Vehicle broke down' }).expect(200);

      const delivery = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery.status).toBe('SEARCHING_DRIVER');
      expect(delivery.driverId).toBeNull();
      expect(delivery.assignedAt).toBeNull();

      const free = await harness.prisma.driverAvailability.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      });
      expect(free.status).toBe('ONLINE');
    });

    it('does not offer the same delivery back to the driver who dropped it', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'cancel').send({ reason: 'Too far' }).expect(200);

      const round = await harness.matching.runRound(deliveryId, 2);
      expect(round.offersMade).toBe(0);
    });

    it('refuses once the package has been collected', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);

      const response = await step(deliveryId, 'cancel').send({ reason: 'Changed my mind' }).expect(422);
      expect(response.body.message).toContain('support');
    });
  });

  describe('customer tracking', () => {
    it('shows the driver, their position and an ETA once assigned', async () => {
      const deliveryId = await accepted();

      const response = await http(harness)
        .get(`${API}/mobile/customer/deliveries/${deliveryId}/tracking`)
        .set(asCustomer())
        .expect(200);

      const { data } = response.body;
      expect(data.status).toBe('DRIVER_ASSIGNED');
      expect(data.driver.fullName).toBe('Chan Sopheak');
      expect(data.driver.plateNumber).toBeTruthy();
      expect(data.driverLocation).not.toBeNull();
      expect(data.eta.heading).toBe('PICKUP');
      expect(data.eta.seconds).toBeGreaterThan(0);
    });

    it('switches the ETA to the drop-off once the package is collected', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);

      const response = await http(harness)
        .get(`${API}/mobile/customer/deliveries/${deliveryId}/tracking`)
        .set(asCustomer())
        .expect(200);

      expect(response.body.data.eta.heading).toBe('DROPOFF');
    });

    it('gives no ETA while the driver is standing at a stop', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);

      const response = await http(harness)
        .get(`${API}/mobile/customer/deliveries/${deliveryId}/tracking`)
        .set(asCustomer())
        .expect(200);

      expect(response.body.data.eta).toBeNull();
    });

    it('stops sharing the driver’s position once delivered, and shows the proof', async () => {
      const deliveryId = await accepted();
      await step(deliveryId, 'arrive-pickup').send({}).expect(200);
      await step(deliveryId, 'confirm-pickup').send({}).expect(200);
      await step(deliveryId, 'arrive-dropoff').send({}).expect(200);
      const photoFileId = await attachProof();
      await step(deliveryId, 'proof-of-delivery').send({ photoFileId, recipientName: 'Chan Vuthy' }).expect(201);
      await step(deliveryId, 'complete').send({}).expect(200);

      const response = await http(harness)
        .get(`${API}/mobile/customer/deliveries/${deliveryId}/tracking`)
        .set(asCustomer())
        .expect(200);

      expect(response.body.data.status).toBe('DELIVERED');
      expect(response.body.data.driverLocation).toBeNull();
      expect(response.body.data.eta).toBeNull();
      expect(response.body.data.proofOfDelivery.recipientName).toBe('Chan Vuthy');
      expect(response.body.data.timeline).toHaveLength(6);
    });

    it('will not track another customer’s delivery', async () => {
      const deliveryId = await accepted();
      const stranger = await activate(harness);

      await http(harness)
        .get(`${API}/mobile/customer/deliveries/${deliveryId}/tracking`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .expect(404);
    });
  });
});
