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

const FINANCE_OPS = ['admin.access', 'deliveries.view', 'finance.view', 'finance.refund'];

/**
 * Cancelling a paid delivery used to leave the customer's money with the
 * platform and no way to send it back. Refunds follow the same discipline as
 * payouts: recording one is an obligation, and settling it is a separate fact
 * about money that actually moved.
 */
describe('Refunds (e2e)', () => {
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
    admin = await adminAccount(harness, FINANCE_OPS);
    customer = await activate(harness);
    driver = await readyDriver(harness, NEARBY);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });

  /** A delivery the customer actually paid for online. */
  async function paidDelivery(amount = 15_800): Promise<{ deliveryId: string; bookingCode: string }> {
    const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

    await harness.prisma.payment.create({
      data: {
        deliveryId: delivery.deliveryId,
        method: 'ABA_KHQR',
        provider: 'ABA_KHQR',
        status: 'PAID',
        amount,
        currency: 'KHR',
        providerRef: 'ABA-PAY-88120',
        paidAt: new Date(),
      },
    });

    return delivery;
  }

  describe('recording what is owed', () => {
    it('refunds the whole payment when no amount is given', async () => {
      const delivery = await paidDelivery();

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Cancelled after pickup; recipient unreachable' })
        .expect(201);

      expect(response.body.data).toMatchObject({
        amount: 15_800,
        paymentAmount: 15_800,
        currency: 'KHR',
        status: 'PENDING',
        bookingCode: delivery.bookingCode,
        customerName: 'Sok Dara',
        requestedByName: 'Ops Operator',
        settledAt: null,
        providerRef: null,
      });

      // Recording it moves nothing: the payment is still a payment.
      const payment = await harness.prisma.payment.findFirstOrThrow({
        where: { deliveryId: delivery.deliveryId },
      });
      expect(payment.status).toBe('PAID');
    });

    it('will not promise more than was taken, counting refunds in flight', async () => {
      const delivery = await paidDelivery();

      await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ amount: 10_000, reason: 'Partial, for the delay' })
        .expect(201);

      // Two operators working the same complaint must not each refund it all.
      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ amount: 10_000, reason: 'Also for the delay' })
        .expect(422);

      expect(response.body.code).toBe('REFUND_EXCEEDS_PAYMENT');
      expect(response.body.message).toContain('5800');

      // The rest is still refundable.
      await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ amount: 5_800, reason: 'The remainder' })
        .expect(201);
    });

    it('refuses a cash booking, which the platform never held', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Customer complained' })
        .expect(422);

      expect(response.body.code).toBe('PAYMENT_NOT_REFUNDABLE');
      expect(response.body.message).toContain('cash fare was never held');
      expect(await harness.prisma.refund.count()).toBe(0);
    });
  });

  describe('settling', () => {
    it('marks the payment refunded only once all of it has gone back', async () => {
      const delivery = await paidDelivery();

      const partial = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ amount: 5_800, reason: 'Partial' })
        .expect(201);

      await http(harness)
        .post(`${API}/admin/finance/refunds/${partial.body.data.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-RFND-1' })
        .expect(200);

      // Still mostly a payment.
      let payment = await harness.prisma.payment.findFirstOrThrow({
        where: { deliveryId: delivery.deliveryId },
      });
      expect(payment.status).toBe('PAID');

      const rest = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'The remainder' })
        .expect(201);
      expect(rest.body.data.amount).toBe(10_000);

      const settled = await http(harness)
        .post(`${API}/admin/finance/refunds/${rest.body.data.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-RFND-2' })
        .expect(200);

      expect(settled.body.data).toMatchObject({
        status: 'SETTLED',
        providerRef: 'ABA-RFND-2',
        settledByName: 'Ops Operator',
      });
      expect(settled.body.data.settledAt).toBeTruthy();

      payment = await harness.prisma.payment.findFirstOrThrow({
        where: { deliveryId: delivery.deliveryId },
      });
      expect(payment.status).toBe('REFUNDED');
    });

    it('demands a provider reference', async () => {
      const delivery = await paidDelivery();
      const refund = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Cancelled' })
        .expect(201);

      const response = await http(harness)
        .post(`${API}/admin/finance/refunds/${refund.body.data.id}/settle`)
        .set(asAdmin())
        .send({})
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('settles only once', async () => {
      const delivery = await paidDelivery();
      const refund = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Cancelled' })
        .expect(201);

      await http(harness)
        .post(`${API}/admin/finance/refunds/${refund.body.data.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-RFND-1' })
        .expect(200);

      const again = await http(harness)
        .post(`${API}/admin/finance/refunds/${refund.body.data.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-RFND-1' })
        .expect(409);

      expect(again.body.code).toBe('REFUND_NOT_SETTLEABLE');
    });

    it('keeps the obligation when an attempt fails', async () => {
      const delivery = await paidDelivery();
      const refund = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Cancelled' })
        .expect(201);

      const failed = await http(harness)
        .post(`${API}/admin/finance/refunds/${refund.body.data.id}/fail`)
        .set(asAdmin())
        .send({ reason: 'Provider rejected: original card expired' })
        .expect(200);

      expect(failed.body.data).toMatchObject({ status: 'FAILED' });
      expect(failed.body.data.failureReason).toContain('expired');

      // A failed attempt does not consume the payment's refundable amount.
      const retry = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Retrying by bank transfer' })
        .expect(201);
      expect(retry.body.data.amount).toBe(15_800);
    });
  });

  describe('the queue and the record', () => {
    it('lists what is owed, oldest first', async () => {
      const first = await paidDelivery();
      const second = await paidDelivery();

      await http(harness)
        .post(`${API}/admin/deliveries/${first.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'One' })
        .expect(201);
      await http(harness)
        .post(`${API}/admin/deliveries/${second.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Two' })
        .expect(201);

      const response = await http(harness)
        .get(`${API}/admin/finance/refunds?status=PENDING`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].bookingCode).toBe(first.bookingCode);
    });

    it('records who asked and who settled', async () => {
      const delivery = await paidDelivery();
      const refund = await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set(asAdmin())
        .send({ reason: 'Cancelled after pickup' })
        .expect(201);
      await http(harness)
        .post(`${API}/admin/finance/refunds/${refund.body.data.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-RFND-9' })
        .expect(200);

      const audit = await harness.prisma.auditLog.findMany({
        where: { entityType: 'Refund' },
        orderBy: { createdAt: 'asc' },
      });

      expect(audit.map((entry) => entry.action)).toEqual(['refund.request', 'refund.settle']);
      expect(audit.every((entry) => entry.actorUserId === admin.userId)).toBe(true);
      expect(audit[1].summary).toContain('ABA-RFND-9');
    });

    it('separates seeing refunds from issuing them', async () => {
      const viewer = await adminAccount(harness, ['admin.access', 'deliveries.view', 'finance.view']);
      const delivery = await paidDelivery();

      await http(harness)
        .get(`${API}/admin/finance/refunds`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .expect(200);

      await http(harness)
        .post(`${API}/admin/deliveries/${delivery.deliveryId}/refund`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .send({ reason: 'No' })
        .expect(403);
    });
  });
});
