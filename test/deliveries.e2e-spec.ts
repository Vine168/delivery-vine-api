import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, type ActivatedAccount } from './helpers.js';

/** Independence Monument → Chak Angrae: ~8.8 km straight line, ~11.5 km by road in the stub. */
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
  note: 'Gate B',
};

describe('Quoting and booking (e2e)', () => {
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
    const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });
    vehicleTypeId = vehicleType.id;
  });

  const auth = () => ({ Authorization: `Bearer ${customer.accessToken}` });

  /** Fields common to a quote and a booking. */
  const quotable = (overrides: Record<string, unknown> = {}) => ({
    pickup: PICKUP,
    dropoff: DROPOFF,
    vehicleTypeId,
    currency: 'KHR',
    packages: [{ size: 'SMALL', weightKg: 3.5, category: 'DRINKS' }],
    ...overrides,
  });

  /** A quote takes no payment method — that is a booking decision. */
  const booking = (overrides: Record<string, unknown> = {}) => ({
    ...quotable(),
    paymentMethod: 'CASH_ON_DELIVERY',
    ...overrides,
  });

  const quote = (overrides: Record<string, unknown> = {}) =>
    http(harness).post(`${API}/mobile/customer/deliveries/quote`).set(auth()).send(quotable(overrides));

  const create = (overrides: Record<string, unknown> = {}) =>
    http(harness).post(`${API}/mobile/customer/deliveries`).set(auth()).send(booking(overrides));

  describe('quoting', () => {
    it('prices a route and writes nothing', async () => {
      const response = await quote().expect(200);
      const { data } = response.body;

      expect(response.body.code).toBe('QUOTE_CALCULATED');
      expect(data.distanceMeters).toBeGreaterThan(1_000);
      expect(data.routeSource).toBe('roktenh');
      expect(data.price.currency).toBe('KHR');
      expect(data.price.baseFare).toBe(4_000);
      expect(data.price.totalAmount).toBeGreaterThan(0);

      expect(await harness.prisma.delivery.count()).toBe(0);
    });

    it('itemises the fare so the app can render a receipt', async () => {
      const { body } = await quote().expect(200);
      const codes = body.data.price.lines.map((line: { code: string }) => line.code);

      expect(codes).toContain('BASE_FARE');
      expect(codes).toContain('SERVICE_FEE');
    });

    it('applies a promo without touching the driver’s earning', async () => {
      const plain = await quote().expect(200);
      const promo = await quote({ promoCode: 'SAVE500' }).expect(200);

      expect(promo.body.data.price.discountAmount).toBe(500);
      expect(promo.body.data.price.totalAmount).toBeLessThan(plain.body.data.price.totalAmount);
      expect(promo.body.data.price.driverEarningAmount).toBe(plain.body.data.price.driverEarningAmount);
    });

    it('charges a fee for collecting cash', async () => {
      const withoutCod = await quote().expect(200);
      const withCod = await quote({ cod: { enabled: true, amount: 40_000, payer: 'RECIPIENT' } }).expect(200);

      expect(withCod.body.data.price.codFee).toBe(400);
      expect(withCod.body.data.price.totalAmount).toBeGreaterThan(withoutCod.body.data.price.totalAmount);
    });

    it('refuses cash on delivery with no amount', async () => {
      const response = await quote({ cod: { enabled: true } }).expect(400);
      expect(response.body.errors[0].field).toBe('cod.amount');
    });

    it('refuses a pickup and drop-off at the same place', async () => {
      const response = await quote({ dropoff: { ...DROPOFF, latitude: PICKUP.latitude, longitude: PICKUP.longitude } })
        .expect(422);

      expect(response.body.code).toBe('DELIVERY_SAME_PICKUP_DROPOFF');
    });

    it('refuses a load the vehicle cannot carry', async () => {
      const tooHeavy = await quote({ packages: [{ size: 'LARGE', weightKg: 80 }] }).expect(422);
      expect(tooHeavy.body.message).toContain('20 kg');

      const tooMany = await quote({
        packages: Array.from({ length: 5 }, () => ({ size: 'SMALL', weightKg: 1 })),
      }).expect(422);
      expect(tooMany.body.message).toContain('3 items');
    });

    it('falls back to an estimate when the map provider is down', async () => {
      harness.map.shouldFail = true;

      const response = await quote().expect(200);
      expect(response.body.data.routeSource).toBe('haversine');
      expect(response.body.data.price.totalAmount).toBeGreaterThan(0);
    });
  });

  describe('creating a booking', () => {
    it('creates it, confirms it and starts the search', async () => {
      const response = await create().expect(201);
      const { data } = response.body;

      expect(response.body.code).toBe('DELIVERY_CREATED');
      expect(data.bookingCode).toMatch(/^ORD-\d{8}-\d{5}$/);
      expect(data.status).toBe('SEARCHING_DRIVER');
      expect(data.driver).toBeNull();
      expect(data.canCancel).toBe(true);
      expect(data.packages).toHaveLength(1);
    });

    it('records the confirmation in the status history', async () => {
      const { body } = await create().expect(201);

      const history = await harness.prisma.deliveryStatusHistory.findMany({
        where: { deliveryId: body.data.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: 'DRAFT',
        toStatus: 'SEARCHING_DRIVER',
        actorType: 'CUSTOMER',
      });
    });

    it('stores money as integers with an explicit currency', async () => {
      const { body } = await create().expect(201);

      const delivery = await harness.prisma.delivery.findUniqueOrThrow({
        where: { id: body.data.id },
        select: {
          totalAmount: true,
          currency: true,
          commissionAmount: true,
          driverEarningAmount: true,
          subtotalAmount: true,
          serviceFee: true,
        },
      });

      for (const [field, value] of Object.entries(delivery)) {
        if (typeof value === 'number') {
          expect(Number.isInteger(value), field).toBe(true);
        }
      }
      expect(delivery.currency).toBe('KHR');
      expect(delivery.commissionAmount + delivery.driverEarningAmount).toBe(
        delivery.subtotalAmount - delivery.serviceFee,
      );
    });

    it('never shows the customer the commission split', async () => {
      const { body } = await create().expect(201);

      expect(body.data.price.commissionAmount).toBe(0);
      expect(body.data.price.driverEarningAmount).toBe(0);
    });

    it('ignores a price the client tries to dictate', async () => {
      const honest = await create().expect(201);

      const tampered = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set(auth())
        .send({ ...booking(), totalAmount: 1, baseFare: 1, price: { totalAmount: 1 } })
        .expect(400);

      // Unknown fields are rejected outright rather than quietly dropped.
      expect(tampered.body.code).toBe('VALIDATION_ERROR');
      expect(honest.body.data.price.totalAmount).toBeGreaterThan(1);
    });

    it('records the promo usage exactly once', async () => {
      const { body } = await create({ promoCode: 'SAVE500' }).expect(201);

      const usages = await harness.prisma.promoCodeUsage.findMany({ where: { deliveryId: body.data.id } });
      expect(usages).toHaveLength(1);
      expect(usages[0].discountAmount).toBe(500);

      const promo = await harness.prisma.promoCode.findFirstOrThrow({ where: { code: 'SAVE500' } });
      expect(promo.usageCount).toBe(1);
    });

    it('enforces the per-customer promo limit across bookings', async () => {
      await harness.prisma.promoCode.updateMany({ where: { code: 'SAVE500' }, data: { perCustomerLimit: 1 } });

      await create({ promoCode: 'SAVE500' }).expect(201);
      const second = await create({ promoCode: 'SAVE500' }).expect(422);

      expect(second.body.code).toBe('PROMO_CUSTOMER_LIMIT_REACHED');
    });

    it('requires at least one package', async () => {
      const response = await create({ packages: [] }).expect(400);
      expect(response.body.errors[0].message).toContain('At least one package');
    });

    it('caps how many deliveries one customer can have in flight', async () => {
      for (let i = 0; i < 5; i += 1) {
        await create().expect(201);
      }

      const sixth = await create().expect(422);
      expect(sixth.body.message).toContain('5 deliveries in progress');
    });
  });

  describe('listing and reading', () => {
    it('paginates newest first', async () => {
      await create().expect(201);
      await create().expect(201);

      const response = await http(harness)
        .get(`${API}/mobile/customer/deliveries?page=1&limit=1`)
        .set(auth())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2, hasNext: true });
    });

    it('filters by status', async () => {
      const created = await create().expect(201);
      await http(harness)
        .post(`${API}/mobile/customer/deliveries/${created.body.data.id}/cancel`)
        .set(auth())
        .send({ reason: 'Changed my mind' })
        .expect(200);
      await create().expect(201);

      const cancelled = await http(harness)
        .get(`${API}/mobile/customer/deliveries?status=CANCELLED`)
        .set(auth())
        .expect(200);

      expect(cancelled.body.data).toHaveLength(1);
      expect(cancelled.body.data[0].status).toBe('CANCELLED');
    });

    it('finds a delivery by its booking code', async () => {
      const created = await create().expect(201);

      const found = await http(harness)
        .get(`${API}/mobile/customer/deliveries?search=${created.body.data.bookingCode}`)
        .set(auth())
        .expect(200);

      expect(found.body.data).toHaveLength(1);
    });

    it('returns the packages', async () => {
      const created = await create().expect(201);

      const packages = await http(harness)
        .get(`${API}/mobile/customer/deliveries/${created.body.data.id}/packages`)
        .set(auth())
        .expect(200);

      expect(packages.body.data[0]).toMatchObject({ size: 'SMALL', quantity: 1, category: 'DRINKS' });
    });

    it('hides one customer’s deliveries from another', async () => {
      const created = await create().expect(201);
      const stranger = await activate(harness);

      await http(harness)
        .get(`${API}/mobile/customer/deliveries/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .expect(404);

      const list = await http(harness)
        .get(`${API}/mobile/customer/deliveries`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .expect(200);

      expect(list.body.data).toHaveLength(0);
    });
  });

  describe('cancelling', () => {
    it('cancels while searching and records who did it', async () => {
      const created = await create().expect(201);

      const response = await http(harness)
        .post(`${API}/mobile/customer/deliveries/${created.body.data.id}/cancel`)
        .set(auth())
        .send({ reason: 'Changed my mind' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'CANCELLED',
        cancelledByType: 'CUSTOMER',
        cancelReason: 'Changed my mind',
        canCancel: false,
      });
    });

    it('refuses a second cancellation', async () => {
      const created = await create().expect(201);
      const path = `${API}/mobile/customer/deliveries/${created.body.data.id}/cancel`;

      await http(harness).post(path).set(auth()).send({}).expect(200);
      const again = await http(harness).post(path).set(auth()).send({}).expect(409);

      expect(again.body.code).toBe('DELIVERY_ALREADY_CANCELLED');
    });

    it('refuses once the driver has the package', async () => {
      const created = await create().expect(201);

      // Drive it forward the way the driver app will in Phase 5.
      await harness.prisma.delivery.update({
        where: { id: created.body.data.id },
        data: { status: 'PICKED_UP' },
      });

      const response = await http(harness)
        .post(`${API}/mobile/customer/deliveries/${created.body.data.id}/cancel`)
        .set(auth())
        .send({})
        .expect(403);

      expect(response.body.code).toBe('DELIVERY_INVALID_TRANSITION');
    });

    it('will not let a stranger cancel someone else’s delivery', async () => {
      const created = await create().expect(201);
      const stranger = await activate(harness);

      await http(harness)
        .post(`${API}/mobile/customer/deliveries/${created.body.data.id}/cancel`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .send({})
        .expect(404);
    });
  });

  describe('rebooking', () => {
    it('creates a fresh booking from an old one, priced today', async () => {
      const first = await create({ promoCode: 'SAVE500' }).expect(201);

      const rebooked = await http(harness)
        .post(`${API}/mobile/customer/deliveries/${first.body.data.id}/rebook`)
        .set(auth())
        .expect(201);

      expect(rebooked.body.data.id).not.toBe(first.body.data.id);
      expect(rebooked.body.data.bookingCode).not.toBe(first.body.data.bookingCode);
      expect(rebooked.body.data.status).toBe('SEARCHING_DRIVER');
      expect(rebooked.body.data.pickup.address).toBe(PICKUP.address);
      // The promo is not silently spent again.
      expect(rebooked.body.data.price.discountAmount).toBe(0);
    });
  });

  describe('promo validation', () => {
    it('accepts a valid code and shows what it saves', async () => {
      const response = await http(harness)
        .post(`${API}/mobile/customer/promos/validate`)
        .set(auth())
        .send({ code: 'save500', subtotal: 10_000, currency: 'KHR' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        code: 'SAVE500',
        discountAmount: 500,
        totalAfterDiscount: 9_500,
      });
    });

    it('rejects an unknown, expired or under-spent code with a specific reason', async () => {
      const unknown = await http(harness)
        .post(`${API}/mobile/customer/promos/validate`)
        .set(auth())
        .send({ code: 'NOPE', subtotal: 10_000, currency: 'KHR' })
        .expect(422);
      expect(unknown.body.code).toBe('PROMO_NOT_FOUND');

      const tooSmall = await http(harness)
        .post(`${API}/mobile/customer/promos/validate`)
        .set(auth())
        .send({ code: 'SAVE500', subtotal: 1_000, currency: 'KHR' })
        .expect(422);
      expect(tooSmall.body.code).toBe('PROMO_MIN_ORDER_NOT_MET');

      await harness.prisma.promoCode.updateMany({
        where: { code: 'SAVE500' },
        data: { endsAt: new Date('2020-01-01') },
      });

      const expired = await http(harness)
        .post(`${API}/mobile/customer/promos/validate`)
        .set(auth())
        .send({ code: 'SAVE500', subtotal: 10_000, currency: 'KHR' })
        .expect(422);
      expect(expired.body.code).toBe('PROMO_EXPIRED');
    });

    it('caps a percentage discount at its maximum', async () => {
      const response = await http(harness)
        .post(`${API}/mobile/customer/promos/validate`)
        .set(auth())
        .send({ code: 'NEW10', subtotal: 100_000, currency: 'KHR' })
        .expect(200);

      // 10% of 100,000 is 10,000, capped at 3,000
      expect(response.body.data.discountAmount).toBe(3_000);
    });
  });
});
