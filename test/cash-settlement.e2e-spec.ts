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

/**
 * Who is holding the money decides which way the ledger moves.
 *
 * On a prepaid booking the platform took the fare and owes the driver their
 * share. On a cash booking the driver was handed the whole fare at the door,
 * commission included, and owes the platform its share. Crediting both — which
 * this system used to do — hands a cash driver their cut of money they already
 * have and writes off the commission entirely.
 */
describe('Cash settlement and driver debt (e2e)', () => {
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
    admin = await adminAccount(harness, [
      'admin.access',
      'finance.view',
      'finance.remittance',
      'finance.adjust',
    ]);
    customer = await activate(harness);
    driver = await readyDriver(harness, NEARBY);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });
  const asDriver = () => ({ Authorization: `Bearer ${driver.accessToken}` });

  const wallet = async () =>
    harness.prisma.wallet.findFirstOrThrow({ where: { userId: driver.userId, currency: 'KHR' } });

  describe('a cash delivery', () => {
    it('charges the driver the commission instead of crediting them', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const balances = await wallet();
      expect(balances.balance).toBe(-delivery.commissionAmount);
      expect(delivery.commissionAmount).toBeGreaterThan(0);

      const entry = await harness.prisma.walletTransaction.findFirstOrThrow({
        where: { referenceType: 'delivery', referenceId: delivery.deliveryId },
      });
      expect(entry).toMatchObject({
        type: 'COMMISSION',
        direction: 'DEBIT',
        amount: delivery.commissionAmount,
        balanceBefore: 0,
        balanceAfter: -delivery.commissionAmount,
      });
      expect(entry.description).toContain('cash');
    });

    it('records the earning as already paid, because it was — at the door', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const earning = await harness.prisma.driverEarning.findUniqueOrThrow({
        where: { deliveryId: delivery.deliveryId },
      });

      expect(earning.status).toBe('PAID');
      expect(earning.cashCollectedAmount).toBe(delivery.totalAmount);
      // The job's economics are unchanged — only the settlement differs.
      expect(earning.netAmount).toBe(delivery.netAmount);
      expect(earning.walletTransactionId).toBeTruthy();
    });

    it('shows the driver what they owe, and nothing to withdraw', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness).get(`${API}/mobile/driver/wallet`).set(asDriver()).expect(200);

      expect(response.body.data[0]).toMatchObject({
        balance: -delivery.commissionAmount,
        availableBalance: 0,
        amountOwed: delivery.commissionAmount,
      });
    });

    it('will not let an overdrawn driver withdraw', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      await http(harness)
        .put(`${API}/mobile/driver/withdrawal-settings`)
        .set(asDriver())
        .send({ bankName: 'ABA Bank', accountHolderName: 'CHAN SOPHEAK', accountNumber: '000123456789' })
        .expect(200);

      const response = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount: 20_000, currency: 'KHR', method: 'BANK_TRANSFER' })
        .expect(422);

      expect(['INSUFFICIENT_BALANCE', 'WITHDRAWAL_AMOUNT_TOO_LOW']).toContain(response.body.code);
    });

    it('accumulates the debt across several jobs', async () => {
      const first = await completedDelivery(harness, customer, driver, vehicleTypeId);
      const second = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const balances = await wallet();
      expect(balances.balance).toBe(-(first.commissionAmount + second.commissionAmount));
    });
  });

  describe('a prepaid delivery', () => {
    it('still credits the driver their share', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const balances = await wallet();
      expect(balances.balance).toBe(delivery.netAmount);

      const entry = await harness.prisma.walletTransaction.findFirstOrThrow({
        where: { referenceType: 'delivery', referenceId: delivery.deliveryId },
      });
      expect(entry).toMatchObject({ type: 'DELIVERY_EARNING', direction: 'CREDIT' });

      const earning = await harness.prisma.driverEarning.findUniqueOrThrow({
        where: { deliveryId: delivery.deliveryId },
      });
      expect(earning.status).toBe('AVAILABLE');
      expect(earning.cashCollectedAmount).toBe(0);
    });

    it('nets off against cash debt in the same wallet', async () => {
      const cash = await completedDelivery(harness, customer, driver, vehicleTypeId);
      const prepaid = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const balances = await wallet();
      expect(balances.balance).toBe(prepaid.netAmount - cash.commissionAmount);

      // Net position is positive, so it is withdrawable again.
      const response = await http(harness).get(`${API}/mobile/driver/wallet`).set(asDriver()).expect(200);
      expect(response.body.data[0].amountOwed).toBe(0);
      expect(response.body.data[0].availableBalance).toBe(prepaid.netAmount - cash.commissionAmount);
    });
  });

  describe('settling up', () => {
    it('clears the debt when the driver hands the cash in', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/remittance`)
        .set(asAdmin())
        .send({
          currency: 'KHR',
          amount: delivery.commissionAmount,
          reference: 'RCPT-0031',
          note: 'Handed in at the Toul Kork hub',
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        currency: 'KHR',
        balance: 0,
        amountOwed: 0,
        availableBalance: 0,
      });

      // It appears on the driver's own statement, in the operator's words.
      const statement = await http(harness)
        .get(`${API}/mobile/driver/wallet/transactions`)
        .set(asDriver())
        .expect(200);

      expect(statement.body.data[0]).toMatchObject({ direction: 'CREDIT', amount: delivery.commissionAmount });
      expect(statement.body.data[0].description).toContain('Toul Kork');
    });

    it('leaves a partial hand-in partly owed', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/remittance`)
        .set(asAdmin())
        .send({ currency: 'KHR', amount: 1_000 })
        .expect(201);

      expect(response.body.data.amountOwed).toBe(delivery.commissionAmount - 1_000);
    });

    it('records who took the cash', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/remittance`)
        .set(asAdmin())
        .send({ currency: 'KHR', amount: 2_000, reference: 'RCPT-0031' })
        .expect(201);

      const audit = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'wallet.remittance' },
      });
      expect(audit.actorUserId).toBe(admin.userId);
      expect(audit.summary).toContain('RCPT-0031');
    });

    it('is refused to an operator who can only view finance', async () => {
      const viewer = await adminAccount(harness, ['admin.access', 'finance.view']);

      await http(harness)
        .post(`${API}/admin/finance/drivers/${driver.driverId}/remittance`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .send({ currency: 'KHR', amount: 1_000 })
        .expect(403);
    });
  });

  describe('the finance overview', () => {
    it('reports what drivers owe separately from what the platform owes', async () => {
      const cash = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const otherDriver = await readyDriver(harness, NEARBY);
      const prepaid = await completedDelivery(harness, customer, otherDriver, vehicleTypeId, 'ABA_KHQR');

      const response = await http(harness)
        .get(`${API}/admin/finance/overview`)
        .set(asAdmin())
        .expect(200);

      const line = response.body.data.liabilities.find(
        (entry: { currency: string }) => entry.currency === 'KHR',
      );

      // A liability and a receivable, not one netted figure.
      expect(line.walletBalance).toBe(prepaid.netAmount);
      expect(line.owedByDrivers).toBe(cash.commissionAmount);
    });
  });

  describe('reconciliation', () => {
    it('settles a delivery whose payout event was lost', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      // Rewind to exactly the state a crash between commit and publish leaves:
      // delivered, earning written, nothing in the ledger.
      await harness.prisma.walletTransaction.deleteMany({
        where: { referenceType: 'delivery', referenceId: delivery.deliveryId },
      });
      await harness.prisma.wallet.updateMany({
        where: { userId: driver.userId },
        data: { balance: 0 },
      });
      await harness.prisma.driverEarning.update({
        where: { deliveryId: delivery.deliveryId },
        data: { status: 'PENDING', walletTransactionId: null },
      });

      const { EarningsReconciliationService } = await import(
        '../src/modules/earnings/earnings-reconciliation.service.js'
      );
      const result = await harness.app.get(EarningsReconciliationService).sweep();

      expect(result.settled).toBe(1);
      expect((await wallet()).balance).toBe(delivery.netAmount);
    });

    it('does nothing to a delivery that settled normally', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const { EarningsReconciliationService } = await import(
        '../src/modules/earnings/earnings-reconciliation.service.js'
      );
      const result = await harness.app.get(EarningsReconciliationService).sweep();

      expect(result.settled).toBe(0);
      expect((await wallet()).balance).toBe(delivery.netAmount);

      const entries = await harness.prisma.walletTransaction.count({
        where: { referenceType: 'delivery', referenceId: delivery.deliveryId },
      });
      expect(entries).toBe(1);
    });

    it('is safe to run repeatedly', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      const { EarningsReconciliationService } = await import(
        '../src/modules/earnings/earnings-reconciliation.service.js'
      );
      const service = harness.app.get(EarningsReconciliationService);
      await service.sweep();
      await service.sweep();

      expect(await harness.prisma.walletTransaction.count()).toBe(1);
    });
  });
});
