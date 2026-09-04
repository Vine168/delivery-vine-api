import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, readyDriver, type ActivatedAccount } from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

const BOOKING = {
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
  currency: 'KHR',
  packages: [{ size: 'SMALL', weightKg: 2 }],
  paymentMethod: 'CASH_ON_DELIVERY',
};

/**
 * A phone on a bad connection retries, and a user taps *Book* twice when
 * nothing visibly happens. Both must produce one delivery, not two.
 */
describe('Idempotent requests (e2e)', () => {
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

  const asCustomer = () => ({ Authorization: `Bearer ${customer.accessToken}` });

  const book = (key?: string) => {
    const request = http(harness).post(`${API}/mobile/customer/deliveries`).set(asCustomer());
    if (key) request.set({ 'Idempotency-Key': key });
    return request.send({ ...BOOKING, vehicleTypeId });
  };

  describe('with a key', () => {
    it('books once and replays the same delivery on a retry', async () => {
      const first = await book('booking-key-1').expect(201);
      const second = await book('booking-key-1').expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.bookingCode).toBe(first.body.data.bookingCode);
      expect(await harness.prisma.delivery.count()).toBe(1);
    });

    it('returns the full envelope on a replay, not a bare payload', async () => {
      await book('booking-key-2').expect(201);
      const replay = await book('booking-key-2').expect(201);

      expect(replay.body).toMatchObject({ success: true, code: 'DELIVERY_CREATED' });
      expect(replay.body.message).toBeTruthy();
    });

    it('refuses a key reused for a different request', async () => {
      await book('booking-key-3').expect(201);

      const response = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set(asCustomer())
        .set({ 'Idempotency-Key': 'booking-key-3' })
        .send({
          ...BOOKING,
          vehicleTypeId,
          dropoff: { ...BOOKING.dropoff, address: 'Somewhere else entirely' },
        })
        .expect(409);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await harness.prisma.delivery.count()).toBe(1);
    });

    it('keeps one customer’s key from colliding with another’s', async () => {
      const other = await activate(harness);

      await book('shared-key').expect(201);
      await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set({ Authorization: `Bearer ${other.accessToken}` })
        .set({ 'Idempotency-Key': 'shared-key' })
        .send({ ...BOOKING, vehicleTypeId })
        .expect(201);

      expect(await harness.prisma.delivery.count()).toBe(2);
    });

    it('creates one delivery when both taps land at once', async () => {
      const [first, second] = await Promise.all([book('double-tap'), book('double-tap')]);

      const statuses = [first.status, second.status].sort();
      // One wins; the other is either told it is in flight or replayed.
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);
      expect(await harness.prisma.delivery.count()).toBe(1);
    });

    it('releases the key when the request fails, so a fixed retry works', async () => {
      const rejected = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set(asCustomer())
        .set({ 'Idempotency-Key': 'retry-after-failure' })
        .send({ ...BOOKING, vehicleTypeId, packages: [] })
        .expect(400);
      expect(rejected.body.code).toBe('VALIDATION_ERROR');

      // The same key, now with a valid body, is not poisoned by the failure.
      await book('retry-after-failure').expect(201);
      expect(await harness.prisma.delivery.count()).toBe(1);
    });

    it('rejects an absurdly long key instead of storing it', async () => {
      const response = await book('k'.repeat(200)).expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(await harness.prisma.idempotencyKey.count()).toBe(0);
    });
  });

  describe('without a key', () => {
    it('behaves exactly as before', async () => {
      await book().expect(201);
      await book().expect(201);

      expect(await harness.prisma.delivery.count()).toBe(2);
      expect(await harness.prisma.idempotencyKey.count()).toBe(0);
    });
  });

  describe('withdrawals', () => {
    it('requests a payout once however many times the tap repeats', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const wallet = await harness.prisma.wallet.create({
        data: { userId: driver.userId, currency: 'KHR', balance: 60_000 },
      });

      await http(harness)
        .put(`${API}/mobile/driver/withdrawal-settings`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .send({ bankName: 'ABA Bank', accountHolderName: 'CHAN SOPHEAK', accountNumber: '000123456789' })
        .expect(200);

      const request = () =>
        http(harness)
          .post(`${API}/mobile/driver/withdrawals`)
          .set({ Authorization: `Bearer ${driver.accessToken}` })
          .set({ 'Idempotency-Key': 'payout-1' })
          .send({ amount: 20_000, currency: 'KHR', method: 'BANK_TRANSFER' });

      const first = await request().expect(201);
      const second = await request().expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await harness.prisma.withdrawal.count()).toBe(1);

      // And only one reservation was taken against the balance.
      const after = await harness.prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      expect(after.reservedBalance).toBe(20_000);
    });
  });

  describe('housekeeping', () => {
    it('prunes keys that have expired', async () => {
      await book('to-be-pruned').expect(201);
      await harness.prisma.idempotencyKey.updateMany({
        data: { expiresAt: new Date(Date.now() - 5 * 86_400_000) },
      });

      const { MaintenanceService } = await import(
        '../src/modules/maintenance/maintenance.service.js'
      );
      const removed = await harness.app.get(MaintenanceService).pruneIdempotencyKeys();

      expect(removed).toBe(1);
      expect(await harness.prisma.idempotencyKey.count()).toBe(0);
    });
  });
});
