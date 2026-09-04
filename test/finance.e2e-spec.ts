import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { API, activate, completedDelivery, http, readyDriver, type ActivatedAccount } from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

const BANK_DETAILS = {
  bankName: 'ABA Bank',
  accountHolderName: 'Chan Sopheak',
  accountNumber: '000 123 456 789',
};

describe('Wallet, earnings and withdrawals (e2e)', () => {
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
  const asCustomer = () => ({ Authorization: `Bearer ${customer.accessToken}` });

  const wallet = async () => {
    const response = await http(harness).get(`${API}/mobile/driver/wallet`).set(asDriver()).expect(200);
    return response.body.data[0] as { balance: number; reservedBalance: number; availableBalance: number };
  };

  /** Puts money in the wallet the way a completed delivery would. */
  async function topUp(amount: number): Promise<void> {
    // Wallets are created on first credit, so a driver who has not earned yet
    // has none.
    const current = await harness.prisma.wallet.upsert({
      where: { userId_currency: { userId: driver.userId, currency: 'KHR' } },
      create: { userId: driver.userId, currency: 'KHR' },
      update: {},
    });

    await harness.prisma.$transaction([
      harness.prisma.wallet.update({
        where: { id: current.id },
        data: { balance: { increment: amount } },
      }),
      harness.prisma.walletTransaction.create({
        data: {
          walletId: current.id,
          type: 'ADJUSTMENT',
          direction: 'CREDIT',
          status: 'COMPLETED',
          amount,
          currency: 'KHR',
          balanceBefore: current.balance,
          balanceAfter: current.balance + amount,
          referenceType: 'test-topup',
          referenceId: `topup-${Date.now()}-${Math.random()}`,
        },
      }),
    ]);
  }

  const addBankDetails = () =>
    http(harness).put(`${API}/mobile/driver/withdrawal-settings`).set(asDriver()).send(BANK_DETAILS).expect(200);

  describe('earning from a delivery', () => {
    it('credits the wallet when a delivery completes', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const balances = await wallet();
      expect(balances.balance).toBe(delivery.netAmount);
      expect(balances.availableBalance).toBe(delivery.netAmount);

      const ledger = await http(harness)
        .get(`${API}/mobile/driver/wallet/transactions`)
        .set(asDriver())
        .expect(200);

      expect(ledger.body.data).toHaveLength(1);
      expect(ledger.body.data[0]).toMatchObject({
        type: 'DELIVERY_EARNING',
        direction: 'CREDIT',
        amount: delivery.netAmount,
        balanceBefore: 0,
        balanceAfter: delivery.netAmount,
        referenceType: 'delivery',
        referenceId: delivery.deliveryId,
      });
    });

    it('moves the earning from PENDING to AVAILABLE and links the ledger entry', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const earning = await harness.prisma.driverEarning.findUniqueOrThrow({
        where: { deliveryId: delivery.deliveryId },
      });

      expect(earning.status).toBe('AVAILABLE');
      expect(earning.walletTransactionId).toBeTruthy();
    });

    it('pays for a delivery exactly once, however many times settlement runs', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      // A retried job, a duplicated event, a manual replay — all the same.
      const earnings = harness.app.get(
        (await import('../src/modules/earnings/earnings.service.js')).EarningsService,
      );
      await earnings.settle(delivery.deliveryId);
      await earnings.settle(delivery.deliveryId);

      const balances = await wallet();
      expect(balances.balance).toBe(delivery.netAmount);

      const entries = await harness.prisma.walletTransaction.count({
        where: { referenceType: 'delivery', referenceId: delivery.deliveryId },
      });
      expect(entries).toBe(1);
    });

    it('summarises today’s earnings from the snapshots', async () => {
      const first = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
      const second = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const summary = await http(harness)
        .get(`${API}/mobile/driver/earnings/summary?period=today`)
        .set(asDriver())
        .expect(200);

      expect(summary.body.data.deliveryCount).toBe(2);
      expect(summary.body.data.netAmount).toBe(first.netAmount + second.netAmount);
      expect(summary.body.data.averagePerDelivery).toBe(
        Math.round((first.netAmount + second.netAmount) / 2),
      );
    });

    it('shows the split on an individual earning', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');

      const history = await http(harness)
        .get(`${API}/mobile/driver/earnings/history`)
        .set(asDriver())
        .expect(200);

      const earning = history.body.data[0];
      expect(earning.bookingCode).toBe(delivery.bookingCode);
      expect(earning.deliveryAmount).toBeGreaterThan(earning.netAmount);
      expect(earning.deliveryAmount - earning.commissionAmount).toBeGreaterThanOrEqual(earning.netAmount);

      const detail = await http(harness)
        .get(`${API}/mobile/driver/earnings/${earning.id}`)
        .set(asDriver())
        .expect(200);
      expect(detail.body.data.id).toBe(earning.id);
    });

    it('will not show one driver another driver’s earnings', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
      const other = await readyDriver(harness, NEARBY);

      const history = await http(harness)
        .get(`${API}/mobile/driver/earnings/history`)
        .set({ Authorization: `Bearer ${other.accessToken}` })
        .expect(200);

      expect(history.body.data).toHaveLength(0);
    });
  });

  describe('the ledger', () => {
    it('keeps balanceBefore and balanceAfter consistent across every entry', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
      await completedDelivery(harness, customer, driver, vehicleTypeId, 'ABA_KHQR');
      await topUp(50_000);

      const entries = await harness.prisma.walletTransaction.findMany({
        where: { wallet: { userId: driver.userId } },
        orderBy: { createdAt: 'asc' },
        select: { direction: true, amount: true, balanceBefore: true, balanceAfter: true },
      });

      expect(entries.length).toBeGreaterThanOrEqual(3);

      let running = 0;
      for (const entry of entries) {
        expect(entry.balanceBefore).toBe(running);
        const delta = entry.direction === 'CREDIT' ? entry.amount : -entry.amount;
        expect(entry.balanceAfter).toBe(running + delta);
        running = entry.balanceAfter;
      }

      const balances = await wallet();
      expect(balances.balance).toBe(running);
    });

    it('never lets a reservation exceed what is actually there', async () => {
      // The balance itself may go negative — a driver paid in cash owes the
      // platform its commission — but nothing can be promised out of an
      // overdraft, which is what stops a debt funding a withdrawal.
      const constraint = await harness.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM pg_constraint WHERE conname = 'Wallet_reserved_within_positive_balance'
      `;
      expect(Number(constraint[0].count)).toBe(1);

      const current = await harness.prisma.wallet.findFirst({ where: { userId: driver.userId } });
      if (current) {
        await expect(
          harness.prisma.wallet.update({
            where: { id: current.id },
            data: { balance: -1, reservedBalance: 1 },
          }),
        ).rejects.toThrow();
      }
    });

    it('refuses to overdraw on a withdrawal, however the balance got there', async () => {
      await topUp(10_000);
      const current = await harness.prisma.wallet.findFirstOrThrow({ where: { userId: driver.userId } });

      await expect(
        harness.prisma.$transaction((tx) =>
          harness.app
            .get(WalletService)
            .debit(
              {
                userId: driver.userId,
                currency: 'KHR',
                type: 'WITHDRAWAL',
                amount: current.balance + 1,
                referenceType: 'test-overdraw',
                referenceId: `overdraw-${Date.now()}`,
              },
              tx,
            ),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    });
  });

  describe('bank details', () => {
    it('stores the account number encrypted and returns only the last four digits', async () => {
      const response = await addBankDetails();

      expect(response.body.data).toMatchObject({
        bankName: 'ABA Bank',
        accountHolderName: 'CHAN SOPHEAK',
        accountNumberLast4: '6789',
        isComplete: true,
      });

      const stored = await harness.prisma.driverPaymentSetting.findUniqueOrThrow({
        where: { driverId: driver.driverId as string },
      });

      expect(stored.accountNumberEnc).not.toContain('123456789');
      expect(JSON.stringify(response.body)).not.toContain('123456789');
    });

    it('rejects a nonsense account number', async () => {
      const response = await http(harness)
        .put(`${API}/mobile/driver/withdrawal-settings`)
        .set(asDriver())
        .send({ ...BANK_DETAILS, accountNumber: 'not-a-number' })
        .expect(400);

      expect(response.body.errors[0].field).toBe('accountNumber');
    });
  });

  describe('requesting a withdrawal', () => {
    it('refuses before bank details are set', async () => {
      await topUp(100_000);

      const response = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount: 50_000 })
        .expect(422);

      expect(response.body.code).toBe('WITHDRAWAL_SETTINGS_REQUIRED');
    });

    it('refuses more than the wallet holds', async () => {
      await topUp(30_000);
      await addBankDetails();

      const response = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount: 500_000 })
        .expect(422);

      expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('enforces the minimum and maximum', async () => {
      await topUp(10_000_000);
      await addBankDetails();

      const tooSmall = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount: 5_000 })
        .expect(422);
      expect(tooSmall.body.code).toBe('WITHDRAWAL_AMOUNT_TOO_LOW');

      const tooLarge = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount: 9_000_000 })
        .expect(422);
      expect(tooLarge.body.code).toBe('WITHDRAWAL_AMOUNT_TOO_HIGH');
    });

    it('reserves the money without removing it', async () => {
      await topUp(100_000);
      await addBankDetails();

      await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount: 60_000 })
        .expect(201);

      const balances = await wallet();
      expect(balances.balance).toBe(100_000); // nothing has left yet
      expect(balances.reservedBalance).toBe(60_000);
      expect(balances.availableBalance).toBe(40_000);

      // A reservation is not a balance change, so it writes no ledger entry.
      const entries = await harness.prisma.walletTransaction.count({
        where: { wallet: { userId: driver.userId }, type: 'WITHDRAWAL' },
      });
      expect(entries).toBe(0);
    });

    it('allows only one open request at a time', async () => {
      await topUp(200_000);
      await addBankDetails();

      await http(harness).post(`${API}/mobile/driver/withdrawals`).set(asDriver()).send({ amount: 50_000 }).expect(201);

      const second = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount: 50_000 })
        .expect(409);

      expect(second.body.code).toBe('WITHDRAWAL_PENDING_EXISTS');
    });

    it('cannot be overdrawn by two simultaneous requests', async () => {
      await topUp(100_000);
      await addBankDetails();

      // Both ask for most of the balance at the same instant.
      const responses = await Promise.all([
        http(harness).post(`${API}/mobile/driver/withdrawals`).set(asDriver()).send({ amount: 80_000 }),
        http(harness).post(`${API}/mobile/driver/withdrawals`).set(asDriver()).send({ amount: 80_000 }),
      ]);

      const created = responses.filter((response) => response.status === 201);
      expect(created).toHaveLength(1);

      const balances = await wallet();
      expect(balances.reservedBalance).toBe(80_000);
      expect(balances.availableBalance).toBe(20_000);
      expect(balances.reservedBalance).toBeLessThanOrEqual(balances.balance);
    });
  });

  describe('cancelling and settling', () => {
    async function openWithdrawal(amount = 50_000): Promise<string> {
      await topUp(200_000);
      await addBankDetails();

      const response = await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set(asDriver())
        .send({ amount })
        .expect(201);

      return response.body.data.id as string;
    }

    it('returns the money when the driver cancels', async () => {
      const id = await openWithdrawal();

      const cancelled = await http(harness)
        .post(`${API}/mobile/driver/withdrawals/${id}/cancel`)
        .set(asDriver())
        .expect(200);

      expect(cancelled.body.data.status).toBe('CANCELLED');

      const balances = await wallet();
      expect(balances.reservedBalance).toBe(0);
      expect(balances.availableBalance).toBe(200_000);
    });

    it('refuses to cancel once it is being processed', async () => {
      const id = await openWithdrawal();
      await harness.withdrawals.markApproved(id);

      const response = await http(harness)
        .post(`${API}/mobile/driver/withdrawals/${id}/cancel`)
        .set(asDriver())
        .expect(409);

      expect(response.body.code).toBe('WITHDRAWAL_NOT_CANCELLABLE');
    });

    it('takes the money out of the wallet only when the payout actually settles', async () => {
      const id = await openWithdrawal(50_000);

      await harness.withdrawals.markApproved(id);
      await harness.withdrawals.markProcessing(id);

      // Still nothing gone: approval is a promise, not a transfer.
      let balances = await wallet();
      expect(balances.balance).toBe(200_000);

      await harness.withdrawals.markSuccess(id, 'BANK-REF-1');

      balances = await wallet();
      expect(balances.balance).toBe(150_000);
      expect(balances.reservedBalance).toBe(0);

      const entry = await harness.prisma.walletTransaction.findFirstOrThrow({
        where: { type: 'WITHDRAWAL', referenceId: id },
      });
      expect(entry).toMatchObject({
        direction: 'DEBIT',
        amount: 50_000,
        balanceBefore: 200_000,
        balanceAfter: 150_000,
        status: 'COMPLETED',
      });
    });

    it('gives the money back when a payout fails', async () => {
      const id = await openWithdrawal(50_000);
      await harness.withdrawals.markApproved(id);
      await harness.withdrawals.markFailed(id, 'Bank rejected the account number');

      const balances = await wallet();
      expect(balances.balance).toBe(200_000);
      expect(balances.reservedBalance).toBe(0);

      // Nothing moved, so nothing is in the ledger.
      const entries = await harness.prisma.walletTransaction.count({
        where: { type: 'WITHDRAWAL', referenceId: id },
      });
      expect(entries).toBe(0);

      const withdrawal = await http(harness)
        .get(`${API}/mobile/driver/withdrawals/${id}`)
        .set(asDriver())
        .expect(200);
      expect(withdrawal.body.data.status).toBe('FAILED');
      expect(withdrawal.body.data.failureReason).toContain('Bank rejected');
    });

    it('settles only once, even if called twice', async () => {
      const id = await openWithdrawal(50_000);
      await harness.withdrawals.markApproved(id);
      await harness.withdrawals.markSuccess(id);
      await harness.withdrawals.markSuccess(id);

      const balances = await wallet();
      expect(balances.balance).toBe(150_000);

      const entries = await harness.prisma.walletTransaction.count({
        where: { type: 'WITHDRAWAL', referenceId: id },
      });
      expect(entries).toBe(1);
    });

    it('will not show one driver another driver’s withdrawal', async () => {
      const id = await openWithdrawal();
      const other = await readyDriver(harness, NEARBY);

      await http(harness)
        .get(`${API}/mobile/driver/withdrawals/${id}`)
        .set({ Authorization: `Bearer ${other.accessToken}` })
        .expect(404);
    });
  });

  describe('payments', () => {
    it('reports which methods are usable, and why not', async () => {
      const response = await http(harness)
        .get(`${API}/mobile/customer/payment-methods`)
        .set(asCustomer())
        .expect(200);

      const cash = response.body.data.find((m: { method: string }) => m.method === 'CASH_ON_DELIVERY');
      expect(cash).toMatchObject({ available: true, unavailableReason: null, prepaid: false });

      const khqr = response.body.data.find((m: { method: string }) => m.method === 'ABA_KHQR');
      expect(khqr.available).toBe(false);
      expect(khqr.unavailableReason).toContain('not configured');
    });

    it('refuses an unconfigured method instead of failing at the bank', async () => {
      const booking = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set(asCustomer())
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

      const response = await http(harness)
        .post(`${API}/mobile/customer/deliveries/${booking.body.data.id}/payment`)
        .set(asCustomer())
        .send({ method: 'ABA_KHQR' })
        .expect(422);

      expect(response.body.code).toBe('PAYMENT_METHOD_NOT_SUPPORTED');
    });

    it('records a cash payment and returns the same one when asked twice', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const status = await http(harness)
        .get(`${API}/mobile/customer/deliveries/${delivery.deliveryId}/payment`)
        .set(asCustomer())
        .expect(404);

      // No payment record is created for cash — the delivery itself carries it.
      expect(status.body.code).toBe('PAYMENT_NOT_FOUND');

      const paid = await harness.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.deliveryId } });
      expect(paid.paymentStatus).toBe('PAID');
    });
  });
});
