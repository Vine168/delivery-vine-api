import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, type ActivatedAccount } from './helpers.js';

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
 * Validating a promo code checks the limits; claiming one has to enforce them.
 * Two bookings arriving together both read a code as having uses left, so the
 * claim is a conditional update rather than a blind increment.
 */
describe('Promo code limits under concurrency (e2e)', () => {
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

  const book = (as: ActivatedAccount, promoCode?: string) =>
    http(harness)
      .post(`${API}/mobile/customer/deliveries`)
      .set({ Authorization: `Bearer ${as.accessToken}` })
      .send({ ...BOOKING, vehicleTypeId, ...(promoCode ? { promoCode } : {}) });

  describe('the total usage limit', () => {
    it('is not exceeded when bookings arrive together', async () => {
      // One use left, and five customers reaching for it at once.
      await harness.prisma.promoCode.update({
        where: { code: 'SAVE500' },
        data: { usageLimit: 1, usageCount: 0, perCustomerLimit: null },
      });

      const customers = await Promise.all([
        activate(harness),
        activate(harness),
        activate(harness),
        activate(harness),
        activate(harness),
      ]);

      const results = await Promise.all(customers.map((who) => book(who, 'SAVE500')));

      const created = results.filter((response) => response.status === 201);
      expect(created).toHaveLength(1);

      // The rest are told plainly, not served a discount that does not exist.
      for (const rejected of results.filter((response) => response.status !== 201)) {
        expect(rejected.status).toBe(422);
        expect(['PROMO_USAGE_LIMIT_REACHED', 'PROMO_INACTIVE']).toContain(rejected.body.code);
      }

      const promo = await harness.prisma.promoCode.findUniqueOrThrow({ where: { code: 'SAVE500' } });
      expect(promo.usageCount).toBe(1);
      expect(await harness.prisma.promoCodeUsage.count()).toBe(1);
    });

    it('counts a discount exactly once per booking', async () => {
      await harness.prisma.promoCode.update({
        where: { code: 'SAVE500' },
        data: { usageLimit: 10, usageCount: 0, perCustomerLimit: null },
      });

      await book(customer, 'SAVE500').expect(201);
      await book(customer, 'SAVE500').expect(201);

      const promo = await harness.prisma.promoCode.findUniqueOrThrow({ where: { code: 'SAVE500' } });
      expect(promo.usageCount).toBe(2);
      expect(await harness.prisma.promoCodeUsage.count()).toBe(2);
    });

    it('leaves the count alone when a booking is rejected', async () => {
      await harness.prisma.promoCode.update({
        where: { code: 'SAVE500' },
        data: { usageLimit: 5, usageCount: 5, perCustomerLimit: null },
      });

      const response = await book(customer, 'SAVE500').expect(422);
      expect(response.body.code).toBe('PROMO_USAGE_LIMIT_REACHED');

      const promo = await harness.prisma.promoCode.findUniqueOrThrow({ where: { code: 'SAVE500' } });
      expect(promo.usageCount).toBe(5);
      expect(await harness.prisma.delivery.count()).toBe(0);
    });
  });

  describe('the per-customer limit', () => {
    it('holds when one person books twice at once', async () => {
      await harness.prisma.promoCode.update({
        where: { code: 'SAVE500' },
        data: { usageLimit: null, usageCount: 0, perCustomerLimit: 1 },
      });

      const results = await Promise.all([
        book(customer, 'SAVE500'),
        book(customer, 'SAVE500'),
        book(customer, 'SAVE500'),
      ]);

      expect(results.filter((response) => response.status === 201)).toHaveLength(1);
      expect(await harness.prisma.promoCodeUsage.count()).toBe(1);

      const rejected = results.find((response) => response.status !== 201);
      expect(rejected?.status).toBe(422);
      expect(rejected?.body.code).toBe('PROMO_CUSTOMER_LIMIT_REACHED');
    });

    it('lets a different customer use the same code', async () => {
      await harness.prisma.promoCode.update({
        where: { code: 'SAVE500' },
        data: { usageLimit: null, usageCount: 0, perCustomerLimit: 1 },
      });
      const other = await activate(harness);

      await book(customer, 'SAVE500').expect(201);
      await book(other, 'SAVE500').expect(201);

      expect(await harness.prisma.promoCodeUsage.count()).toBe(2);
    });

    it('allows exactly as many uses as the limit says', async () => {
      await harness.prisma.promoCode.update({
        where: { code: 'SAVE500' },
        data: { usageLimit: null, usageCount: 0, perCustomerLimit: 2 },
      });

      await book(customer, 'SAVE500').expect(201);
      await book(customer, 'SAVE500').expect(201);
      const third = await book(customer, 'SAVE500').expect(422);

      expect(third.body.code).toBe('PROMO_CUSTOMER_LIMIT_REACHED');
      expect(await harness.prisma.promoCodeUsage.count()).toBe(2);
    });
  });

  describe('the discount itself', () => {
    it('is applied to the booking that won the claim', async () => {
      await harness.prisma.promoCode.update({
        where: { code: 'SAVE500' },
        data: { usageLimit: 1, usageCount: 0, perCustomerLimit: null },
      });

      const response = await book(customer, 'SAVE500').expect(201);

      expect(response.body.data.price.discountAmount).toBe(500);
      const usage = await harness.prisma.promoCodeUsage.findFirstOrThrow();
      expect(usage.discountAmount).toBe(500);
      expect(usage.deliveryId).toBe(response.body.data.id);
    });
  });
});
