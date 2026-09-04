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

const CONFIG_OPS = [
  'admin.access',
  'pricing.view',
  'pricing.manage',
  'zones.view',
  'zones.manage',
  'promoCodes.view',
  'promoCodes.manage',
  'settings.view',
  'settings.manage',
  'drivers.view',
  'drivers.edit',
];

const POLYGON = {
  type: 'Polygon',
  coordinates: [
    [
      [104.9, 11.5],
      [104.96, 11.5],
      [104.96, 11.6],
      [104.9, 11.6],
      [104.9, 11.5],
    ],
  ],
};

describe('Back office — pricing, zones, promos and settings (e2e)', () => {
  let harness: TestHarness;
  let admin: AdminAccount;
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
    admin = await adminAccount(harness, CONFIG_OPS);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });

  // ── Vehicle types ──────────────────────────────────────────────────────

  describe('vehicle types', () => {
    it('lists them with what depends on each', async () => {
      await readyDriver(harness, NEARBY);

      const response = await http(harness)
        .get(`${API}/admin/pricing/vehicle-types`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        code: 'MOTOR',
        driverCount: 1,
        pricingRuleCount: 1,
      });
    });

    it('refuses a duplicate code', async () => {
      const response = await http(harness)
        .post(`${API}/admin/pricing/vehicle-types`)
        .set(asAdmin())
        .send({ code: 'MOTOR', name: 'Another motorbike' })
        .expect(409);

      expect(response.body.code).toBe('VEHICLE_TYPE_CODE_TAKEN');
    });

    it('adds one, and it is not bookable until it has a price', async () => {
      const created = await http(harness)
        .post(`${API}/admin/pricing/vehicle-types`)
        .set(asAdmin())
        .send({ code: 'VAN', name: 'Van', maxWeightKg: 500, routingProfile: 'MOTOR', sortOrder: 3 })
        .expect(201);

      expect(created.body.data).toMatchObject({ code: 'VAN', pricingRuleCount: 0, isActive: true });

      const customer = await activate(harness);
      const quote = await http(harness)
        .post(`${API}/mobile/customer/deliveries/quote`)
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
          vehicleTypeId: created.body.data.id,
          currency: 'KHR',
        })
        .expect(422);

      expect(quote.body.code).toBe('PRICING_RULE_NOT_FOUND');
    });
  });

  // ── Pricing rules ──────────────────────────────────────────────────────

  describe('pricing rules', () => {
    it('changes what the next booking costs, and nothing already priced', async () => {
      const customer = await activate(harness);
      const driver = await readyDriver(harness, NEARBY);
      const before = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
      const priced = await harness.prisma.delivery.findUniqueOrThrow({
        where: { id: before.deliveryId },
      });

      const rule = await harness.prisma.pricingRule.findFirstOrThrow({ select: { id: true } });

      const updated = await http(harness)
        .patch(`${API}/admin/pricing/rules/${rule.id}`)
        .set(asAdmin())
        .send({ baseFare: 9_000, pricePerKm: 2_000 })
        .expect(200);

      expect(updated.body.data.baseFare).toBe(9_000);
      expect(updated.body.data.version).toBe(2);

      // The settled delivery is untouched: its amounts, its commission and the
      // driver's earning all still say what they said.
      const after = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: before.deliveryId } });
      expect(after.totalAmount).toBe(priced.totalAmount);
      expect(after.commissionAmount).toBe(priced.commissionAmount);
      expect(after.driverEarningAmount).toBe(priced.driverEarningAmount);

      const earning = await harness.prisma.driverEarning.findUniqueOrThrow({
        where: { deliveryId: before.deliveryId },
      });
      expect(earning.netAmount).toBe(before.netAmount);

      // A new quote uses the new rule.
      const quote = await http(harness)
        .post(`${API}/mobile/customer/deliveries/quote`)
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
        })
        .expect(200);

      expect(quote.body.data.price.baseFare).toBe(9_000);
      expect(quote.body.data.price.totalAmount).toBeGreaterThan(priced.totalAmount);
    });

    it('creates a zone rule that outranks the general one', async () => {
      const zone = await http(harness)
        .post(`${API}/admin/zones`)
        .set(asAdmin())
        .send({
          code: 'PP-CENTRAL',
          name: 'Central',
          coverageType: 'RADIUS',
          centerLatitude: 11.5564,
          centerLongitude: 104.9282,
          radiusMeters: 8_000,
        })
        .expect(201);

      const created = await http(harness)
        .post(`${API}/admin/pricing/rules`)
        .set(asAdmin())
        .send({
          name: 'MOTOR central (KHR)',
          vehicleTypeId,
          zoneId: zone.body.data.id,
          currency: 'KHR',
          baseFare: 6_000,
          pricePerKm: 1_200,
          commissionPercentBp: 1_500,
          priority: 10,
        })
        .expect(201);

      expect(created.body.data).toMatchObject({
        zoneCode: 'PP-CENTRAL',
        priority: 10,
        deliveryCount: 0,
        version: 1,
      });

      const listed = await http(harness).get(`${API}/admin/pricing/rules`).set(asAdmin()).expect(200);
      // Highest priority first — the order the pricing engine resolves in.
      expect(listed.body.data[0].id).toBe(created.body.data.id);
    });

    it('rejects a commission floor above its ceiling', async () => {
      const response = await http(harness)
        .post(`${API}/admin/pricing/rules`)
        .set(asAdmin())
        .send({
          name: 'Broken',
          vehicleTypeId,
          currency: 'KHR',
          baseFare: 4_000,
          minCommission: 20_000,
          maxCommission: 1_000,
        })
        .expect(422);

      expect(response.body.message).toContain('minimum commission');
    });

    it('retires a rule without deleting it', async () => {
      const rule = await harness.prisma.pricingRule.findFirstOrThrow({ select: { id: true } });

      const response = await http(harness)
        .delete(`${API}/admin/pricing/rules/${rule.id}`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data.isActive).toBe(false);
      expect(await harness.prisma.pricingRule.count({ where: { id: rule.id } })).toBe(1);
    });
  });

  // ── Zones ──────────────────────────────────────────────────────────────

  describe('zones', () => {
    it('stores one shape, never both', async () => {
      const created = await http(harness)
        .post(`${API}/admin/zones`)
        .set(asAdmin())
        .send({
          code: 'PP-RIVER',
          name: 'Riverside',
          city: 'Phnom Penh',
          coverageType: 'RADIUS',
          centerLatitude: 11.5564,
          centerLongitude: 104.9282,
          radiusMeters: 5_000,
        })
        .expect(201);

      expect(created.body.data).toMatchObject({
        coverageType: 'RADIUS',
        radiusMeters: 5_000,
        boundary: null,
      });

      // Switching to a polygon clears the circle.
      const redrawn = await http(harness)
        .patch(`${API}/admin/zones/${created.body.data.id}`)
        .set(asAdmin())
        .send({ coverageType: 'POLYGON', boundary: POLYGON })
        .expect(200);

      expect(redrawn.body.data).toMatchObject({
        coverageType: 'POLYGON',
        centerLatitude: null,
        centerLongitude: null,
        radiusMeters: null,
      });
      expect(redrawn.body.data.boundary).toMatchObject({ type: 'Polygon' });
    });

    it('requires the parts of the shape it claims to be', async () => {
      const missingRadius = await http(harness)
        .post(`${API}/admin/zones`)
        .set(asAdmin())
        .send({ code: 'BAD-1', name: 'No radius', coverageType: 'RADIUS' })
        .expect(400);
      expect(missingRadius.body.code).toBe('VALIDATION_ERROR');

      const missingBoundary = await http(harness)
        .post(`${API}/admin/zones`)
        .set(asAdmin())
        .send({ code: 'BAD-2', name: 'No boundary', coverageType: 'POLYGON' })
        .expect(400);
      expect(missingBoundary.body.code).toBe('VALIDATION_ERROR');
    });

    it('retires a zone and releases the drivers assigned to it', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const zone = await http(harness)
        .post(`${API}/admin/zones`)
        .set(asAdmin())
        .send({ code: 'PP-OLD', name: 'Old town', coverageType: 'POLYGON', boundary: POLYGON })
        .expect(201);

      await http(harness)
        .put(`${API}/admin/drivers/${driver.driverId}/zones`)
        .set(asAdmin())
        .send({ zoneIds: [zone.body.data.id] })
        .expect(200);

      await http(harness).delete(`${API}/admin/zones/${zone.body.data.id}`).set(asAdmin()).expect(200);

      await http(harness).get(`${API}/admin/zones/${zone.body.data.id}`).set(asAdmin()).expect(404);

      // The zone row survives for anything that referenced it, but nobody is
      // shown as covering it.
      expect(await harness.prisma.zone.count({ where: { id: zone.body.data.id } })).toBe(1);
      expect(await harness.prisma.driverZone.count({ where: { zoneId: zone.body.data.id } })).toBe(0);

      const fleet = await http(harness)
        .get(`${API}/admin/drivers/${driver.driverId}`)
        .set(asAdmin())
        .expect(200);
      expect(fleet.body.data.zones).toEqual([]);
    });
  });

  // ── Promo codes ────────────────────────────────────────────────────────

  describe('promo codes', () => {
    it('reports whether a code could be used right now', async () => {
      const response = await http(harness)
        .get(`${API}/admin/promo-codes?runningNow=true`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data.map((row: { code: string }) => row.code).sort()).toEqual([
        'NEW10',
        'SAVE500',
      ]);
      expect(response.body.data.every((row: { isRunning: boolean }) => row.isRunning)).toBe(true);
    });

    it('sums the discount actually given, not the counter', async () => {
      const customer = await activate(harness);
      const driver = await readyDriver(harness, NEARBY);

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
          promoCode: 'SAVE500',
        })
        .expect(201);

      expect(booking.body.data.price.discountAmount).toBe(500);
      expect(driver.driverId).toBeTruthy();

      const promos = await http(harness)
        .get(`${API}/admin/promo-codes?search=SAVE500`)
        .set(asAdmin())
        .expect(200);

      expect(promos.body.data[0]).toMatchObject({ usageCount: 1, discountGiven: 500 });
    });

    it('refuses a usage limit below what has already been redeemed', async () => {
      const promo = await harness.prisma.promoCode.findFirstOrThrow({ where: { code: 'SAVE500' } });
      await harness.prisma.promoCode.update({ where: { id: promo.id }, data: { usageCount: 12 } });

      const response = await http(harness)
        .patch(`${API}/admin/promo-codes/${promo.id}`)
        .set(asAdmin())
        .send({ usageLimit: 5 })
        .expect(422);

      expect(response.body.code).toBe('PROMO_LIMIT_BELOW_USAGE');
      expect(response.body.message).toContain('12 times');
    });

    it('refuses a window that ends before it starts, and a discount over 100%', async () => {
      const badWindow = await http(harness)
        .post(`${API}/admin/promo-codes`)
        .set(asAdmin())
        .send({
          code: 'BACKWARDS',
          name: 'Backwards',
          currency: 'KHR',
          discountType: 'FIXED_AMOUNT',
          discountValue: 500,
          startsAt: '2026-12-01T00:00:00Z',
          endsAt: '2026-11-01T00:00:00Z',
        })
        .expect(422);
      expect(badWindow.body.message).toContain('end after it starts');

      const tooMuch = await http(harness)
        .post(`${API}/admin/promo-codes`)
        .set(asAdmin())
        .send({
          code: 'FREEBIE',
          name: 'Free',
          currency: 'KHR',
          discountType: 'PERCENTAGE',
          discountValue: 12_000,
          startsAt: '2026-09-01T00:00:00Z',
          endsAt: '2026-12-01T00:00:00Z',
        })
        .expect(422);
      expect(tooMuch.body.message).toContain('100%');
    });

    it('withdraws a code so customers can no longer use it', async () => {
      const promo = await harness.prisma.promoCode.findFirstOrThrow({ where: { code: 'SAVE500' } });
      const customer = await activate(harness);

      await http(harness).delete(`${API}/admin/promo-codes/${promo.id}`).set(asAdmin()).expect(200);

      const quote = await http(harness)
        .post(`${API}/mobile/customer/deliveries/quote`)
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
          promoCode: 'SAVE500',
        })
        .expect(422);

      expect(quote.body.code).toBe('PROMO_NOT_FOUND');
    });
  });

  // ── Settings ───────────────────────────────────────────────────────────

  describe('settings', () => {
    it('lists only keys the platform actually reads', async () => {
      const response = await http(harness).get(`${API}/admin/settings`).set(asAdmin()).expect(200);

      const keys = response.body.data.map((row: { key: string }) => row.key);
      expect(keys).toContain('matching.radiusMeters');
      expect(keys).toContain('payout.minAmountKhr');
      expect(response.body.data.every((row: { isOverridden: boolean }) => !row.isOverridden)).toBe(true);

      const radius = response.body.data.find((row: { key: string }) => row.key === 'matching.radiusMeters');
      expect(radius).toMatchObject({ kind: 'integer', unit: 'metres', value: radius.defaultValue });
    });

    it('refuses a key nothing reads', async () => {
      const response = await http(harness)
        .put(`${API}/admin/settings/matching.somethingInvented`)
        .set(asAdmin())
        .send({ value: 1 })
        .expect(404);

      expect(response.body.code).toBe('SETTING_NOT_FOUND');
      expect(await harness.prisma.systemSetting.count()).toBe(0);
    });

    it('refuses a value outside the safe range', async () => {
      const response = await http(harness)
        .put(`${API}/admin/settings/matching.batchSize`)
        .set(asAdmin())
        .send({ value: 500 })
        .expect(400);

      expect(response.body.message).toContain('cannot be above');
    });

    it('changes how the matcher behaves, without a deploy', async () => {
      const customer = await activate(harness);
      // Two drivers, both in range of the pickup.
      await readyDriver(harness, NEARBY);
      await readyDriver(harness, { latitude: 11.558, longitude: 104.93 });

      await http(harness)
        .put(`${API}/admin/settings/matching.batchSize`)
        .set(asAdmin())
        .send({ value: 1 })
        .expect(200);

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

      // One offer, because an operator said one.
      const round = await harness.matching.runRound(booking.body.data.id, 1);
      expect(round.offersMade).toBe(1);
    });

    it('changes the payout minimum a driver is held to', async () => {
      const customer = await activate(harness);
      const driver = await readyDriver(harness, NEARBY);
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      await http(harness)
        .put(`${API}/mobile/driver/withdrawal-settings`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .send({ bankName: 'ABA Bank', accountHolderName: 'CHAN SOPHEAK', accountNumber: '000123456789' })
        .expect(200);

      // The default minimum is ៛20,000, and one delivery does not reach it.
      const tooSmall = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .send({ amount: delivery.netAmount, currency: 'KHR', method: 'BANK_TRANSFER' })
        .expect(422);
      expect(tooSmall.body.code).toBe('WITHDRAWAL_AMOUNT_TOO_LOW');

      await http(harness)
        .put(`${API}/admin/settings/payout.minAmountKhr`)
        .set(asAdmin())
        .send({ value: 1_000 })
        .expect(200);

      await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .send({ amount: delivery.netAmount, currency: 'KHR', method: 'BANK_TRANSFER' })
        .expect(201);
    });

    it('resets to the deployment default, and records both changes', async () => {
      await http(harness)
        .put(`${API}/admin/settings/matching.maxRounds`)
        .set(asAdmin())
        .send({ value: 7 })
        .expect(200);

      const reset = await http(harness)
        .delete(`${API}/admin/settings/matching.maxRounds`)
        .set(asAdmin())
        .expect(200);

      expect(reset.body.data.isOverridden).toBe(false);
      expect(reset.body.data.value).toBe(reset.body.data.defaultValue);

      const audit = await harness.prisma.auditLog.findMany({
        where: { entityType: 'SystemSetting' },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((entry) => entry.action)).toEqual(['setting.update', 'setting.reset']);
      expect(audit[0].summary).toContain('7');
    });
  });

  // ── Permissions ────────────────────────────────────────────────────────

  describe('permissions', () => {
    it('separates reading configuration from changing it', async () => {
      const viewer = await adminAccount(harness, [
        'admin.access',
        'pricing.view',
        'zones.view',
        'promoCodes.view',
        'settings.view',
      ]);
      const rule = await harness.prisma.pricingRule.findFirstOrThrow({ select: { id: true } });

      await http(harness)
        .get(`${API}/admin/pricing/rules`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .expect(200);

      await http(harness)
        .patch(`${API}/admin/pricing/rules/${rule.id}`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .send({ baseFare: 1 })
        .expect(403);

      await http(harness)
        .put(`${API}/admin/settings/matching.maxRounds`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .send({ value: 2 })
        .expect(403);

      await http(harness)
        .post(`${API}/admin/zones`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .send({ code: 'X', name: 'X', coverageType: 'POLYGON', boundary: POLYGON })
        .expect(403);
    });
  });
});
