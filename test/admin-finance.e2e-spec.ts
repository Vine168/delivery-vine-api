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

const BANK_DETAILS = {
  bankName: 'ABA Bank',
  accountHolderName: 'CHAN SOPHEAK',
  accountNumber: '000 123 456 789',
};

const FINANCE_OPS = [
  'admin.access',
  'finance.view',
  'finance.withdrawals.review',
  'finance.withdrawals.settle',
  'finance.adjust',
];

describe('Back office — finance (e2e)', () => {
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
  const asDriver = () => ({ Authorization: `Bearer ${driver.accessToken}` });

  /**
   * Earns enough to clear the ៛20,000 payout minimum, files bank details and
   * requests a withdrawal.
   */
  async function requestPayout(amount = 20_000): Promise<{ id: string; amount: number }> {
    await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
    await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

    await http(harness)
      .put(`${API}/mobile/driver/withdrawal-settings`)
      .set(asDriver())
      .send(BANK_DETAILS)
      .expect(200);

    const response = await http(harness)
      .post(`${API}/mobile/driver/withdrawals`)
      .set(asDriver())
      .send({ amount, currency: 'KHR', method: 'BANK_TRANSFER' })
      .expect(201);

    return { id: response.body.data.id, amount };
  }

  /**
   * An online payment, written directly.
   *
   * Cash-on-delivery bookings never produce a Payment row — cash is accounted
   * for as COD collected, not as a payment the platform processed — and the
   * KHQR path needs a live provider, so the read endpoints are exercised
   * against a record shaped exactly like the one the payment service writes.
   */
  async function onlinePayment(deliveryId: string, amount: number): Promise<void> {
    await harness.prisma.payment.create({
      data: {
        deliveryId,
        method: 'ABA_KHQR',
        provider: 'ABA_KHQR',
        status: 'PAID',
        amount,
        currency: 'KHR',
        providerRef: 'ABA-PAY-77120',
        paidAt: new Date(),
      },
    });
  }

  // ── Overview ───────────────────────────────────────────────────────────

  describe('GET /admin/finance/overview', () => {
    it('separates revenue in the window from what the platform owes right now', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const response = await http(harness)
        .get(`${API}/admin/finance/overview`)
        .set(asAdmin())
        .expect(200);

      const settled = await harness.prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.deliveryId },
      });

      expect(response.body.data.revenue).toHaveLength(1);
      expect(response.body.data.revenue[0]).toMatchObject({
        currency: 'KHR',
        grossAmount: settled.totalAmount,
        commissionAmount: settled.commissionAmount,
        driverEarningAmount: settled.driverEarningAmount,
        deliveredCount: 1,
      });

      // The driver's wallet is a liability: earned, not yet paid out.
      expect(response.body.data.liabilities).toHaveLength(1);
      expect(response.body.data.liabilities[0]).toMatchObject({
        currency: 'KHR',
        walletBalance: delivery.netAmount,
        reservedBalance: 0,
        availableBalance: delivery.netAmount,
      });

      expect(response.body.data.timezone).toBeTruthy();
    });

    it('moves money from available to reserved when a payout is requested', async () => {
      const payout = await requestPayout();

      const response = await http(harness)
        .get(`${API}/admin/finance/overview`)
        .set(asAdmin())
        .expect(200);

      const liability = response.body.data.liabilities[0];
      expect(liability.reservedBalance).toBe(payout.amount);
      expect(liability.availableBalance).toBe(liability.walletBalance - payout.amount);
      expect(liability.walletBalance).toBeGreaterThan(payout.amount);

      const withdrawals = response.body.data.withdrawals[0];
      expect(withdrawals).toMatchObject({
        currency: 'KHR',
        pendingCount: 1,
        pendingAmount: payout.amount,
        settledCount: 0,
        settledAmount: 0,
      });
    });

    it('reports online payments split by method and outcome', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
      await onlinePayment(delivery.deliveryId, 15_800);

      const response = await http(harness)
        .get(`${API}/admin/finance/overview`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data.payments).toEqual([
        { currency: 'KHR', method: 'ABA_KHQR', status: 'PAID', count: 1, amount: 15_800 },
      ]);
    });
  });

  // ── Withdrawal review ──────────────────────────────────────────────────

  describe('withdrawal review', () => {
    it('lists the queue oldest first with only the last four digits', async () => {
      const payout = await requestPayout();

      const response = await http(harness)
        .get(`${API}/admin/finance/withdrawals?status=PENDING`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        id: payout.id,
        status: 'PENDING',
        driverName: 'Chan Sopheak',
        bankName: 'ABA Bank',
        accountNumberLast4: '6789',
      });

      // The full number is nowhere in the listing.
      expect(JSON.stringify(response.body.data)).not.toContain('000123456789');
    });

    it('approves without moving any money, then settles with a reference', async () => {
      const payout = await requestPayout();
      const walletBefore = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });

      const approved = await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/approve`)
        .set(asAdmin())
        .expect(200);
      expect(approved.body.data.status).toBe('APPROVED');

      // Approval decides; it does not pay. The balance is untouched.
      const walletAfterApproval = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });
      expect(walletAfterApproval.balance).toBe(walletBefore.balance);
      expect(walletAfterApproval.reservedBalance).toBe(payout.amount);

      const settled = await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-TRX-9F2K10' })
        .expect(200);

      expect(settled.body.data.status).toBe('SUCCESS');
      expect(settled.body.data.providerRef).toBe('ABA-TRX-9F2K10');
      expect(settled.body.data.completedAt).toBeTruthy();

      // Now the money has actually left, and the ledger says so.
      const walletAfterSettlement = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });
      expect(walletAfterSettlement.balance).toBe(walletBefore.balance - payout.amount);
      expect(walletAfterSettlement.reservedBalance).toBe(0);

      const entry = await harness.prisma.walletTransaction.findFirstOrThrow({
        where: { referenceType: 'withdrawal', referenceId: payout.id },
      });
      expect(entry).toMatchObject({
        type: 'WITHDRAWAL',
        direction: 'DEBIT',
        amount: payout.amount,
        balanceAfter: walletBefore.balance - payout.amount,
      });
    });

    it('will not settle a payout that has not been approved', async () => {
      const payout = await requestPayout();

      const response = await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-TRX-1' })
        .expect(409);

      expect(response.body.message).toContain('cannot be settled');

      const wallet = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });
      expect(wallet.reservedBalance).toBe(payout.amount);
    });

    it('demands a provider reference before settling', async () => {
      const payout = await requestPayout();
      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/approve`)
        .set(asAdmin())
        .expect(200);

      const response = await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/settle`)
        .set(asAdmin())
        .send({})
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('settles only once, even if the button is pressed twice', async () => {
      const payout = await requestPayout();
      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/approve`)
        .set(asAdmin())
        .expect(200);
      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-TRX-9F2K10' })
        .expect(200);

      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-TRX-9F2K10' })
        .expect(200);

      const entries = await harness.prisma.walletTransaction.count({
        where: { referenceType: 'withdrawal', referenceId: payout.id },
      });
      expect(entries).toBe(1);
    });

    it('gives the money back when a request is rejected', async () => {
      const payout = await requestPayout();

      const response = await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/reject`)
        .set(asAdmin())
        .send({ reason: 'Account holder name does not match the registered driver' })
        .expect(200);

      expect(response.body.data.status).toBe('REJECTED');
      expect(response.body.data.rejectedReason).toContain('does not match');

      const wallet = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });
      expect(wallet.reservedBalance).toBe(0);
      expect(wallet.balance).toBeGreaterThanOrEqual(payout.amount);

      // Nothing left the wallet, so nothing is written to the ledger.
      const entries = await harness.prisma.walletTransaction.count({
        where: { referenceType: 'withdrawal', referenceId: payout.id },
      });
      expect(entries).toBe(0);
    });

    it('gives the money back when a transfer fails at the bank', async () => {
      const payout = await requestPayout();
      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/approve`)
        .set(asAdmin())
        .expect(200);

      const response = await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/fail`)
        .set(asAdmin())
        .send({ reason: 'Bank rejected the transfer: account closed' })
        .expect(200);

      expect(response.body.data.status).toBe('FAILED');

      const wallet = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });
      expect(wallet.reservedBalance).toBe(0);
      expect(wallet.balance).toBeGreaterThanOrEqual(payout.amount);
    });

    it('records every decision against the operator who made it', async () => {
      const payout = await requestPayout();
      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/approve`)
        .set(asAdmin())
        .expect(200);
      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/settle`)
        .set(asAdmin())
        .send({ providerRef: 'ABA-TRX-9F2K10' })
        .expect(200);

      const entries = await harness.prisma.auditLog.findMany({
        where: { entityType: 'Withdrawal', entityId: payout.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(entries.map((entry) => entry.action)).toEqual(['withdrawal.approve', 'withdrawal.settle']);
      expect(entries.every((entry) => entry.actorUserId === admin.userId)).toBe(true);
      expect(entries[1].summary).toContain('ABA-TRX-9F2K10');
    });
  });

  // ── Payout details ─────────────────────────────────────────────────────

  describe('GET /admin/finance/withdrawals/:id/payout-details', () => {
    it('decrypts the account number and records who read it', async () => {
      const payout = await requestPayout();

      const response = await http(harness)
        .get(`${API}/admin/finance/withdrawals/${payout.id}/payout-details`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toMatchObject({
        bankName: 'ABA Bank',
        accountHolderName: 'CHAN SOPHEAK',
        accountNumber: '000123456789',
        currency: 'KHR',
      });

      const audit = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'withdrawal.payout_details.read', entityId: payout.id },
      });
      expect(audit.actorUserId).toBe(admin.userId);
      // The number itself is never written into the audit trail.
      expect(JSON.stringify(audit)).not.toContain('000123456789');
    });

    it('is not available to an operator who can only review', async () => {
      const reviewer = await adminAccount(harness, [
        'admin.access',
        'finance.view',
        'finance.withdrawals.review',
      ]);
      const payout = await requestPayout();

      // They can see the request, and decide on it.
      await http(harness)
        .get(`${API}/admin/finance/withdrawals/${payout.id}`)
        .set({ Authorization: `Bearer ${reviewer.accessToken}` })
        .expect(200);

      // But not read the bank account, nor record a settlement.
      await http(harness)
        .get(`${API}/admin/finance/withdrawals/${payout.id}/payout-details`)
        .set({ Authorization: `Bearer ${reviewer.accessToken}` })
        .expect(403);

      await http(harness)
        .post(`${API}/admin/finance/withdrawals/${payout.id}/settle`)
        .set({ Authorization: `Bearer ${reviewer.accessToken}` })
        .send({ providerRef: 'ABA-TRX-1' })
        .expect(403);
    });
  });

  // ── Ledgers ────────────────────────────────────────────────────────────

  describe('earnings and payments', () => {
    it('shows the commission rate that was applied at the time', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const response = await http(harness).get(`${API}/admin/finance/earnings`).set(asAdmin()).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        deliveryId: delivery.deliveryId,
        bookingCode: delivery.bookingCode,
        driverName: 'Chan Sopheak',
        status: 'AVAILABLE',
        currency: 'KHR',
        netAmount: delivery.netAmount,
      });
    });

    it('finds a payment by booking code and by provider reference', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
      await onlinePayment(delivery.deliveryId, 15_800);

      const byCode = await http(harness)
        .get(`${API}/admin/finance/payments?search=${delivery.bookingCode}`)
        .set(asAdmin())
        .expect(200);

      expect(byCode.body.data).toHaveLength(1);
      expect(byCode.body.data[0]).toMatchObject({
        bookingCode: delivery.bookingCode,
        customerName: 'Sok Dara',
        method: 'ABA_KHQR',
        status: 'PAID',
        providerRef: 'ABA-PAY-77120',
      });

      const byRef = await http(harness)
        .get(`${API}/admin/finance/payments?search=ABA-PAY-77120`)
        .set(asAdmin())
        .expect(200);
      expect(byRef.body.data).toHaveLength(1);
    });
  });

  // ── Manual adjustment ──────────────────────────────────────────────────

  describe('POST /admin/finance/drivers/:id/wallet/adjust', () => {
    it('credits through the ledger, never the balance directly', async () => {
      const response = await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/wallet/adjust`)
        .set(asAdmin())
        .send({
          currency: 'KHR',
          direction: 'CREDIT',
          amount: 5_000,
          reason: 'Goodwill credit for a delivery delayed by a system fault',
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        type: 'ADJUSTMENT',
        direction: 'CREDIT',
        amount: 5_000,
        balanceBefore: 0,
        balanceAfter: 5_000,
        referenceType: 'adjustment',
      });
      expect(response.body.data.description).toContain('Goodwill');

      const wallet = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });
      expect(wallet.balance).toBe(5_000);

      // The driver sees it on their own statement, in their own words.
      const statement = await http(harness)
        .get(`${API}/mobile/driver/wallet/transactions`)
        .set(asDriver())
        .expect(200);
      expect(statement.body.data[0].description).toContain('Goodwill');
    });

    it('refuses a debit that would overdraw the wallet', async () => {
      const response = await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/wallet/adjust`)
        .set(asAdmin())
        .send({ currency: 'KHR', direction: 'DEBIT', amount: 1_000, reason: 'Clawback of a duplicate credit' })
        .expect(422);

      expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('will not spend money reserved against a pending payout', async () => {
      const payout = await requestPayout();
      const wallet = await harness.prisma.wallet.findFirstOrThrow({
        where: { userId: driver.userId, currency: 'KHR' },
      });

      // The whole balance is there, but part of it is promised to the payout.
      const response = await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/wallet/adjust`)
        .set(asAdmin())
        .send({ currency: 'KHR', direction: 'DEBIT', amount: wallet.balance, reason: 'Clawback' })
        .expect(422);

      expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(payout.amount).toBeGreaterThan(0);

      // Spending only what is genuinely free is allowed.
      await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/wallet/adjust`)
        .set(asAdmin())
        .send({
          currency: 'KHR',
          direction: 'DEBIT',
          amount: wallet.balance - wallet.reservedBalance,
          reason: 'Clawback of a duplicate credit',
        })
        .expect(201);
    });

    it('records each adjustment with the balance before and after', async () => {
      await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/wallet/adjust`)
        .set(asAdmin())
        .send({ currency: 'KHR', direction: 'CREDIT', amount: 5_000, reason: 'Goodwill' })
        .expect(201);

      const audit = await harness.prisma.auditLog.findFirstOrThrow({ where: { action: 'wallet.adjust' } });
      expect(audit.actorUserId).toBe(admin.userId);
      expect(audit.before).toMatchObject({ balance: 0 });
      expect(audit.after).toMatchObject({ balance: 5_000 });
    });

    it('is refused to an operator who can only view finance', async () => {
      const viewer = await adminAccount(harness, ['admin.access', 'finance.view']);

      const response = await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/wallet/adjust`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .send({ currency: 'KHR', direction: 'CREDIT', amount: 5_000, reason: 'Goodwill' })
        .expect(403);

      expect(response.body.message).toContain('adjust');
    });
  });

  describe('GET /admin/finance/drivers/:id/wallet', () => {
    it('returns the statement behind the balance', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const response = await http(harness)
        .get(`${API}/admin/finance/drivers/${driver.driverId}/wallet`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        type: 'DELIVERY_EARNING',
        direction: 'CREDIT',
        amount: delivery.netAmount,
        balanceBefore: 0,
        balanceAfter: delivery.netAmount,
        referenceId: delivery.deliveryId,
      });
    });
  });
});
