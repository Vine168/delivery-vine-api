import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { CryptoUtil } from '../../../common/utils/crypto.util.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import { TimeUtil } from '../../../common/utils/time.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  Currency,
  DeliveryStatus,
  EarningStatus,
  LedgerDirection,
  PaymentStatus,
  WalletTransactionType,
  WithdrawalStatus,
} from '../../../generated/prisma/enums.js';
import { WalletService } from '../../wallets/wallet.service.js';
import { WithdrawalsService } from '../../withdrawals/withdrawals.service.js';
import { AuditService } from '../audit.service.js';
import type {
  AdminDriverBalanceDto,
  AdminEarningQueryDto,
  AdminEarningRowDto,
  AdminFinanceOverviewDto,
  AdminFinanceQueryDto,
  AdminLiabilityLineDto,
  AdminPaymentQueryDto,
  AdminPaymentRowDto,
  AdminPayoutDetailsDto,
  AdminRemittanceDto,
  AdminSettleWithdrawalDto,
  AdminWalletAdjustmentDto,
  AdminWalletTransactionDto,
  AdminWalletTransactionQueryDto,
  AdminWithdrawalDetailDto,
  AdminWithdrawalQueryDto,
  AdminWithdrawalRowDto,
} from '../dto/admin-finance.dto.js';
import type { AdminReasonDto } from '../dto/admin-driver.dto.js';

const DEFAULT_WINDOW_DAYS = 29;

const IN_FLIGHT_WITHDRAWALS: WithdrawalStatus[] = [WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING];

const withdrawalSelect = {
  id: true,
  driverId: true,
  status: true,
  method: true,
  amount: true,
  fee: true,
  netAmount: true,
  currency: true,
  bankName: true,
  accountHolderName: true,
  accountNumberLast4: true,
  providerRef: true,
  rejectedReason: true,
  failureReason: true,
  requestedAt: true,
  processedAt: true,
  completedAt: true,
  driver: { select: { fullName: true, user: { select: { phone: true } } } },
} as const;

/**
 * The money screens.
 *
 * Two rules are load-bearing. Nothing here recomputes a historical figure: the
 * numbers come from what was actually written at the time — the delivery's own
 * amounts, the earning's own snapshot, the ledger — never from today's pricing
 * rules. And nothing here moves money outside the ledger: a manual adjustment
 * goes through the same credit/debit path a delivery does, so the balance and
 * the statement can never disagree.
 *
 * Settlement is deliberately a two-step: an operator approves a request, and a
 * different action records that the bank actually paid it. A withdrawal is
 * never marked successful because someone pressed approve.
 */
@Injectable()
export class AdminFinanceService {
  private readonly logger = new Logger(AdminFinanceService.name);
  private readonly timezone: string;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly withdrawals: WithdrawalsService,
    private readonly wallets: WalletService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.timezone = config.get<string>('app.timezone', 'Asia/Phnom_Penh');
    this.encryptionKey = config.getOrThrow<string>('app.encryptionKey');
  }

  // ── Overview ───────────────────────────────────────────────────────────

  async overview(query: AdminFinanceQueryDto): Promise<AdminFinanceOverviewDto> {
    const to = query.dateTo
      ? TimeUtil.startOfDay(this.timezone, new Date(query.dateTo))
      : TimeUtil.startOfDay(this.timezone);
    const from = query.dateFrom
      ? TimeUtil.startOfDay(this.timezone, new Date(query.dateFrom))
      : TimeUtil.addDays(to, -DEFAULT_WINDOW_DAYS);
    const toExclusive = TimeUtil.addDays(to, 1);

    const settledInRange = { gte: from, lt: toExclusive };

    const [revenue, cod, wallets, pendingEarnings, withdrawalGroups, payments] = await Promise.all([
      this.prisma.delivery.groupBy({
        by: ['currency'],
        where: { status: DeliveryStatus.DELIVERED, deliveredAt: settledInRange, deletedAt: null },
        _count: { _all: true },
        _sum: { totalAmount: true, commissionAmount: true, driverEarningAmount: true },
      }),
      this.prisma.delivery.groupBy({
        by: ['codCurrency'],
        where: { codEnabled: true, codCollectedAt: settledInRange, deletedAt: null },
        _sum: { codAmount: true },
      }),
      // Liabilities are a position, not a flow: what is owed right now,
      // regardless of the reporting window.
      this.walletPositions(),
      this.prisma.driverEarning.groupBy({
        by: ['currency'],
        where: { status: EarningStatus.PENDING },
        _sum: { netAmount: true },
      }),
      this.prisma.withdrawal.groupBy({
        by: ['currency', 'status'],
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.payment.groupBy({
        by: ['currency', 'method', 'status'],
        where: { createdAt: settledInRange },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    // Settled totals are the one withdrawal figure that belongs to the window;
    // the rest are open queues, which are always "now".
    const settled = await this.prisma.withdrawal.groupBy({
      by: ['currency'],
      where: { status: WithdrawalStatus.SUCCESS, completedAt: settledInRange },
      _count: { _all: true },
      _sum: { amount: true },
    });

    const codByCurrency = new Map(
      cod.filter((row) => row.codCurrency).map((row) => [row.codCurrency as Currency, row._sum.codAmount ?? 0]),
    );

    const currencies = new Set<Currency>([
      ...wallets.map((row) => row.currency),
      ...pendingEarnings.map((row) => row.currency),
    ]);

    const liabilities: AdminLiabilityLineDto[] = [...currencies].map((currency) => {
      const wallet = wallets.find((row) => row.currency === currency);
      const balance = wallet?.owedToDrivers ?? 0;
      const reserved = wallet?.reserved ?? 0;

      return {
        currency,
        walletBalance: balance,
        owedByDrivers: wallet?.owedByDrivers ?? 0,
        reservedBalance: reserved,
        availableBalance: balance - reserved,
        pendingEarnings:
          pendingEarnings.find((row) => row.currency === currency)?._sum.netAmount ?? 0,
      };
    });

    const withdrawalCurrencies = new Set<Currency>([
      ...withdrawalGroups.map((row) => row.currency),
      ...settled.map((row) => row.currency),
    ]);

    return {
      dateFrom: TimeUtil.dayKey(this.timezone, from),
      dateTo: TimeUtil.dayKey(this.timezone, to),
      timezone: this.timezone,
      revenue: revenue.map((row) => ({
        currency: row.currency,
        grossAmount: row._sum.totalAmount ?? 0,
        commissionAmount: row._sum.commissionAmount ?? 0,
        driverEarningAmount: row._sum.driverEarningAmount ?? 0,
        codCollectedAmount: codByCurrency.get(row.currency) ?? 0,
        deliveredCount: row._count._all,
      })),
      liabilities,
      withdrawals: [...withdrawalCurrencies].map((currency) => {
        const forCurrency = withdrawalGroups.filter((row) => row.currency === currency);
        const sumWhere = (statuses: WithdrawalStatus[]) =>
          forCurrency
            .filter((row) => statuses.includes(row.status))
            .reduce(
              (totals, row) => ({
                count: totals.count + row._count._all,
                amount: totals.amount + (row._sum.amount ?? 0),
              }),
              { count: 0, amount: 0 },
            );

        const pending = sumWhere([WithdrawalStatus.PENDING]);
        const inFlight = sumWhere(IN_FLIGHT_WITHDRAWALS);
        const paid = settled.find((row) => row.currency === currency);

        return {
          currency,
          pendingCount: pending.count,
          pendingAmount: pending.amount,
          inFlightCount: inFlight.count,
          inFlightAmount: inFlight.amount,
          settledCount: paid?._count._all ?? 0,
          settledAmount: paid?._sum.amount ?? 0,
        };
      }),
      payments: payments.map((row) => ({
        currency: row.currency,
        method: row.method,
        status: row.status,
        count: row._count._all,
        amount: row._sum.amount ?? 0,
      })),
    };
  }

  // ── Withdrawals ────────────────────────────────────────────────────────

  async findWithdrawals(query: AdminWithdrawalQueryDto): Promise<PaginatedResult<AdminWithdrawalRowDto>> {
    const where = this.withdrawalWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        // Oldest first: this is a work queue, and the person who has waited
        // longest should be paid first.
        orderBy: { requestedAt: 'asc' },
        skip: query.skip,
        take: query.limit,
        select: withdrawalSelect,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.toWithdrawal(row)), query.page, query.limit, total);
  }

  /** Exposed so an export covers exactly the rows the screen is showing. */
  withdrawalWhere(query: AdminWithdrawalQueryDto): Prisma.WithdrawalWhereInput {
    return {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.driverId ? { driverId: query.driverId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            requestedAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: this.endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { accountHolderName: { contains: query.search, mode: 'insensitive' } },
              { driver: { fullName: { contains: query.search, mode: 'insensitive' } } },
              { driver: { user: { phone: { contains: query.search } } } },
            ],
          }
        : {}),
    };
  }

  async findWithdrawal(id: string): Promise<AdminWithdrawalDetailDto> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      select: {
        ...withdrawalSelect,
        wallet: { select: { balance: true, reservedBalance: true } },
      },
    });

    if (!withdrawal) throw AppException.notFound(ResponseCode.WITHDRAWAL_NOT_FOUND);

    const previousSettlements = await this.prisma.withdrawal.count({
      where: { driverId: withdrawal.driverId, status: WithdrawalStatus.SUCCESS, NOT: { id } },
    });

    return {
      ...this.toWithdrawal(withdrawal),
      walletBalance: withdrawal.wallet.balance,
      walletReserved: withdrawal.wallet.reservedBalance,
      previousSettlements,
    };
  }

  async approveWithdrawal(actorUserId: string, id: string): Promise<AdminWithdrawalDetailDto> {
    const before = await this.findWithdrawal(id);

    await this.withdrawals.markApproved(id);

    await this.audit.record({
      actorUserId,
      action: 'withdrawal.approve',
      entityType: 'Withdrawal',
      entityId: id,
      summary: `Approved ${before.currency} ${before.amount} for ${before.driverName}`,
      before: { status: before.status },
      after: { status: WithdrawalStatus.APPROVED },
    });

    return this.findWithdrawal(id);
  }

  async rejectWithdrawal(
    actorUserId: string,
    id: string,
    dto: AdminReasonDto,
  ): Promise<AdminWithdrawalDetailDto> {
    const before = await this.findWithdrawal(id);

    // Rejection releases the reservation: nothing ever left the wallet.
    await this.withdrawals.markFailed(id, dto.reason, true);

    await this.audit.record({
      actorUserId,
      action: 'withdrawal.reject',
      entityType: 'Withdrawal',
      entityId: id,
      summary: `Rejected ${before.currency} ${before.amount} for ${before.driverName}: ${dto.reason}`,
      before: { status: before.status },
      after: { status: WithdrawalStatus.REJECTED, reason: dto.reason },
    });

    return this.findWithdrawal(id);
  }

  /**
   * Records that the transfer actually happened.
   *
   * This is the only call that takes money out of a wallet, and it demands a
   * provider reference: a settlement that cannot be traced to a real bank
   * transaction is indistinguishable from a mistake six months later.
   */
  async settleWithdrawal(
    actorUserId: string,
    id: string,
    dto: AdminSettleWithdrawalDto,
  ): Promise<AdminWithdrawalDetailDto> {
    const before = await this.findWithdrawal(id);

    await this.withdrawals.markSuccess(id, dto.providerRef);

    await this.audit.record({
      actorUserId,
      action: 'withdrawal.settle',
      entityType: 'Withdrawal',
      entityId: id,
      summary: `Settled ${before.currency} ${before.netAmount} to ${before.driverName} (${dto.providerRef})`,
      before: { status: before.status, walletBalance: before.walletBalance },
      after: { status: WithdrawalStatus.SUCCESS, providerRef: dto.providerRef },
    });

    return this.findWithdrawal(id);
  }

  /** The transfer was attempted and did not go through. The money goes back. */
  async failWithdrawal(
    actorUserId: string,
    id: string,
    dto: AdminReasonDto,
  ): Promise<AdminWithdrawalDetailDto> {
    const before = await this.findWithdrawal(id);

    await this.withdrawals.markFailed(id, dto.reason);

    await this.audit.record({
      actorUserId,
      action: 'withdrawal.fail',
      entityType: 'Withdrawal',
      entityId: id,
      summary: `Marked failed: ${before.currency} ${before.amount} for ${before.driverName} — ${dto.reason}`,
      before: { status: before.status },
      after: { status: WithdrawalStatus.FAILED, reason: dto.reason },
    });

    return this.findWithdrawal(id);
  }

  /**
   * The full bank account number, for the person making the transfer.
   *
   * Everywhere else shows the last four digits. This endpoint exists because
   * someone genuinely has to type the whole number into a banking screen — and
   * because reading it should leave a trace, which it does: every call writes
   * an audit entry naming who looked and at whose account.
   */
  async payoutDetails(actorUserId: string, id: string): Promise<AdminPayoutDetailsDto> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      select: {
        id: true,
        driverId: true,
        status: true,
        netAmount: true,
        currency: true,
        bankName: true,
        accountHolderName: true,
        driver: { select: { fullName: true, paymentSetting: { select: { accountNumberEnc: true } } } },
      },
    });

    if (!withdrawal) throw AppException.notFound(ResponseCode.WITHDRAWAL_NOT_FOUND);

    const encrypted = withdrawal.driver.paymentSetting?.accountNumberEnc;
    if (!encrypted || !withdrawal.bankName || !withdrawal.accountHolderName) {
      throw AppException.unprocessable(
        ResponseCode.WITHDRAWAL_SETTINGS_REQUIRED,
        'This driver has no bank account on file.',
      );
    }

    await this.audit.record({
      actorUserId,
      action: 'withdrawal.payout_details.read',
      entityType: 'Withdrawal',
      entityId: id,
      summary: `Read full bank details for ${withdrawal.driver.fullName}`,
      after: { status: withdrawal.status },
    });

    return {
      withdrawalId: withdrawal.id,
      bankName: withdrawal.bankName,
      accountHolderName: withdrawal.accountHolderName,
      accountNumber: CryptoUtil.decrypt(encrypted, this.encryptionKey),
      netAmount: withdrawal.netAmount,
      currency: withdrawal.currency,
    };
  }

  // ── Earnings and payments ──────────────────────────────────────────────

  async findEarnings(query: AdminEarningQueryDto): Promise<PaginatedResult<AdminEarningRowDto>> {
    const where: Prisma.DriverEarningWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.driverId ? { driverId: query.driverId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            earnedAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: this.endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.driverEarning.findMany({
        where,
        orderBy: { earnedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          driverId: true,
          deliveryId: true,
          status: true,
          currency: true,
          deliveryAmount: true,
          commissionPercentBp: true,
          commissionAmount: true,
          tipAmount: true,
          bonusAmount: true,
          netAmount: true,
          earnedAt: true,
          driver: { select: { fullName: true } },
          delivery: { select: { bookingCode: true } },
        },
      }),
      this.prisma.driverEarning.count({ where }),
    ]);

    return PaginationUtil.paginate(
      rows.map((row) => ({
        id: row.id,
        driverId: row.driverId,
        driverName: row.driver.fullName,
        deliveryId: row.deliveryId,
        bookingCode: row.delivery.bookingCode,
        status: row.status,
        currency: row.currency,
        deliveryAmount: row.deliveryAmount,
        commissionPercentBp: row.commissionPercentBp,
        commissionAmount: row.commissionAmount,
        tipAmount: row.tipAmount,
        bonusAmount: row.bonusAmount,
        netAmount: row.netAmount,
        earnedAt: row.earnedAt.toISOString(),
      })),
      query.page,
      query.limit,
      total,
    );
  }

  async findPayments(query: AdminPaymentQueryDto): Promise<PaginatedResult<AdminPaymentRowDto>> {
    const where: Prisma.PaymentWhereInput = {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: this.endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { providerRef: { contains: query.search, mode: 'insensitive' } },
              { delivery: { bookingCode: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          deliveryId: true,
          method: true,
          provider: true,
          status: true,
          amount: true,
          currency: true,
          providerRef: true,
          failureReason: true,
          paidAt: true,
          createdAt: true,
          delivery: {
            select: { bookingCode: true, customer: { select: { fullName: true } } },
          },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return PaginationUtil.paginate(
      rows.map((row) => ({
        id: row.id,
        deliveryId: row.deliveryId,
        bookingCode: row.delivery.bookingCode,
        customerName: row.delivery.customer.fullName,
        method: row.method,
        provider: row.provider,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        providerRef: row.providerRef,
        failureReason: row.failureReason,
        paidAt: row.paidAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      query.page,
      query.limit,
      total,
    );
  }

  // ── Wallet ledger ──────────────────────────────────────────────────────

  async walletTransactions(
    driverId: string,
    query: AdminWalletTransactionQueryDto,
  ): Promise<PaginatedResult<AdminWalletTransactionDto>> {
    const driver = await this.loadDriver(driverId);

    const where: Prisma.WalletTransactionWhereInput = {
      wallet: {
        userId: driver.userId,
        ...(query.currency ? { currency: query.currency } : {}),
      },
      ...(query.type ? { type: query.type } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          type: true,
          direction: true,
          amount: true,
          currency: true,
          balanceBefore: true,
          balanceAfter: true,
          referenceType: true,
          referenceId: true,
          description: true,
          createdAt: true,
        },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return PaginationUtil.paginate(
      rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      query.page,
      query.limit,
      total,
    );
  }

  /**
   * Moves money into or out of a driver's wallet by hand.
   *
   * Goodwill credits and corrections are real needs, so the platform provides
   * them — through the ledger, with a reason, under its own permission. The
   * balance is never touched directly: this writes the same kind of entry a
   * completed delivery does, so the statement always explains the balance. A
   * debit cannot overdraw, for the same reason a withdrawal cannot.
   */
  async adjustWallet(
    actorUserId: string,
    driverId: string,
    dto: AdminWalletAdjustmentDto,
  ): Promise<AdminWalletTransactionDto> {
    const driver = await this.loadDriver(driverId);
    const reference = `adjustment:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    const entry = await this.prisma.$transaction((tx) => {
      const input = {
        userId: driver.userId,
        currency: dto.currency,
        type: WalletTransactionType.ADJUSTMENT,
        amount: dto.amount,
        referenceType: 'adjustment',
        referenceId: reference,
        description: dto.reason,
        metadata: { adjustedByUserId: actorUserId },
      };

      return dto.direction === LedgerDirection.CREDIT
        ? this.wallets.credit(input, tx)
        : this.wallets.debit(input, tx);
    });

    await this.audit.record({
      actorUserId,
      action: 'wallet.adjust',
      entityType: 'Wallet',
      entityId: entry.walletId,
      summary: `${dto.direction === LedgerDirection.CREDIT ? 'Credited' : 'Debited'} ${dto.currency} ${dto.amount} to ${driver.fullName}: ${dto.reason}`,
      before: { balance: entry.balanceBefore },
      after: { balance: entry.balanceAfter, transactionId: entry.transactionId },
    });

    const written = await this.prisma.walletTransaction.findUniqueOrThrow({
      where: { id: entry.transactionId },
      select: {
        id: true,
        type: true,
        direction: true,
        amount: true,
        currency: true,
        balanceBefore: true,
        balanceAfter: true,
        referenceType: true,
        referenceId: true,
        description: true,
        createdAt: true,
      },
    });

    return { ...written, createdAt: written.createdAt.toISOString() };
  }

  /**
   * Records cash a driver has handed in.
   *
   * The counterpart to charging commission on a cash delivery: that leaves the
   * driver's account overdrawn because they are holding money that is not
   * theirs, and this is how the money comes back. A credit through the same
   * ledger as everything else, so the statement continues to explain the
   * balance line by line.
   *
   * Deliberately not netted against anything or auto-applied to specific
   * deliveries — the driver hands over an amount, the platform records that
   * amount, and the account moves by exactly it.
   */
  async recordRemittance(
    actorUserId: string,
    driverId: string,
    dto: AdminRemittanceDto,
  ): Promise<AdminDriverBalanceDto> {
    const driver = await this.loadDriver(driverId);
    const reference = dto.reference?.trim() || `remittance-${Date.now()}`;

    const entry = await this.prisma.$transaction((tx) =>
      this.wallets.credit(
        {
          userId: driver.userId,
          currency: dto.currency,
          type: WalletTransactionType.TOP_UP,
          amount: dto.amount,
          referenceType: 'remittance',
          referenceId: reference,
          description: dto.note?.trim() || `Cash handed in (${reference})`,
          metadata: { recordedByUserId: actorUserId, reference },
        },
        tx,
      ),
    );

    await this.audit.record({
      actorUserId,
      action: 'wallet.remittance',
      entityType: 'Wallet',
      entityId: entry.walletId,
      summary: `Recorded ${dto.currency} ${dto.amount} handed in by ${driver.fullName} (${reference})`,
      before: { balance: entry.balanceBefore },
      after: { balance: entry.balanceAfter, reference },
    });

    return this.driverBalance(driver.userId, dto.currency);
  }

  /** Where a driver stands with the platform in one currency. */
  async driverBalance(userId: string, currency: Currency): Promise<AdminDriverBalanceDto> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
      select: { balance: true, reservedBalance: true },
    });

    const position = wallet ?? { balance: 0, reservedBalance: 0 };

    return {
      currency,
      balance: position.balance,
      reservedBalance: position.reservedBalance,
      availableBalance: this.wallets.availableOf(position),
      amountOwed: this.wallets.owedOf(position),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * What the platform owes drivers and what drivers owe the platform.
   *
   * Summed in opposite directions rather than netted: a wallet in credit is a
   * liability and an overdrawn one is a receivable, and a single total would
   * hide both behind whichever happened to be larger.
   */
  private async walletPositions(): Promise<
    { currency: Currency; owedToDrivers: number; owedByDrivers: number; reserved: number }[]
  > {
    const rows = await this.prisma.$queryRaw<
      { currency: Currency; owed_to_drivers: bigint; owed_by_drivers: bigint; reserved: bigint }[]
    >`
      SELECT
        "currency",
        SUM(GREATEST("balance", 0))::bigint  AS owed_to_drivers,
        SUM(GREATEST(-"balance", 0))::bigint AS owed_by_drivers,
        SUM("reservedBalance")::bigint       AS reserved
      FROM "Wallet"
      GROUP BY "currency"
    `;

    return rows.map((row) => ({
      currency: row.currency,
      owedToDrivers: Number(row.owed_to_drivers),
      owedByDrivers: Number(row.owed_by_drivers),
      reserved: Number(row.reserved),
    }));
  }

  private async loadDriver(driverId: string) {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id: driverId, deletedAt: null },
      select: { id: true, userId: true, fullName: true },
    });

    if (!driver) throw AppException.notFound(ResponseCode.DRIVER_NOT_FOUND);
    return driver;
  }

  private toWithdrawal(
    row: Prisma.WithdrawalGetPayload<{ select: typeof withdrawalSelect }>,
  ): AdminWithdrawalRowDto {
    return {
      id: row.id,
      driverId: row.driverId,
      driverName: row.driver.fullName,
      driverPhone: row.driver.user.phone,
      status: row.status,
      method: row.method,
      amount: row.amount,
      fee: row.fee,
      netAmount: row.netAmount,
      currency: row.currency,
      bankName: row.bankName,
      accountHolderName: row.accountHolderName,
      accountNumberLast4: row.accountNumberLast4,
      providerRef: row.providerRef,
      rejectedReason: row.rejectedReason,
      failureReason: row.failureReason,
      requestedAt: row.requestedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private endOfDay(date: string): Date {
    const parsed = new Date(date);
    parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  }
}
