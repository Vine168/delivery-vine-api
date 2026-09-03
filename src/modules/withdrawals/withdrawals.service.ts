import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { CryptoUtil } from '../../common/utils/crypto.util.js';
import { PaginationUtil } from '../../common/utils/pagination.util.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Currency,
  FilePurpose,
  LedgerDirection,
  WalletTransactionStatus,
  WalletTransactionType,
  WithdrawalStatus,
} from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { WalletService } from '../wallets/wallet.service.js';
import type {
  CreateWithdrawalDto,
  ListWithdrawalsQueryDto,
  UpdateWithdrawalSettingsDto,
  WithdrawalDto,
  WithdrawalSettingsDto,
} from './dto/withdrawal.dto.js';

/** Statuses where money is still committed and the request is not finished. */
const OPEN_STATUSES = [
  WithdrawalStatus.PENDING,
  WithdrawalStatus.APPROVED,
  WithdrawalStatus.PROCESSING,
] as const;

const withdrawalSelect = {
  id: true,
  driverId: true,
  walletId: true,
  status: true,
  method: true,
  amount: true,
  fee: true,
  netAmount: true,
  currency: true,
  bankName: true,
  accountHolderName: true,
  accountNumberLast4: true,
  rejectedReason: true,
  failureReason: true,
  requestedAt: true,
  processedAt: true,
  completedAt: true,
} as const;

/**
 * Driver payouts.
 *
 * The money is reserved the moment a request is made, not when an admin gets
 * round to it — otherwise a driver could request the same balance twice in two
 * taps. A reservation moves nothing: it takes the amount out of the spendable
 * pool while leaving it in the balance, so the ledger stays whole. The balance
 * only falls when the payout genuinely settles, and that write also creates
 * the ledger entry.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    private readonly uploads: UploadsService,
    private readonly fileUrls: FileUrlService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {
    this.encryptionKey = this.config.getOrThrow<string>('app.encryptionKey');
  }

  // ── Bank details ───────────────────────────────────────────────────────

  async getSettings(driverId: string): Promise<WithdrawalSettingsDto> {
    const settings = await this.prisma.driverPaymentSetting.findUnique({
      where: { driverId },
      select: {
        bankName: true,
        accountHolderName: true,
        accountNumberLast4: true,
        khqrFileId: true,
        updatedAt: true,
      },
    });

    if (!settings) {
      return {
        bankName: null,
        accountHolderName: null,
        accountNumberLast4: null,
        khqrImageUrl: null,
        isComplete: false,
        updatedAt: null,
      };
    }

    return {
      bankName: settings.bankName,
      accountHolderName: settings.accountHolderName,
      accountNumberLast4: settings.accountNumberLast4,
      khqrImageUrl: await this.fileUrls.resolveById(settings.khqrFileId),
      isComplete: this.isComplete(settings),
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  /**
   * The account number is encrypted at rest and never returned in full — the
   * driver already knows it, and nothing in the platform reads it back except
   * the payout file.
   */
  async updateSettings(
    driverId: string,
    userId: string,
    dto: UpdateWithdrawalSettingsDto,
  ): Promise<WithdrawalSettingsDto> {
    if (dto.khqrFileId) {
      await this.uploads.assertOwnedForPurpose(dto.khqrFileId, userId, [FilePurpose.KHQR_IMAGE]);
    }

    const digits = dto.accountNumber.replace(/\D/g, '');

    const data = {
      bankName: dto.bankName.trim(),
      accountHolderName: dto.accountHolderName.trim().toUpperCase(),
      accountNumberEnc: CryptoUtil.encrypt(digits, this.encryptionKey),
      accountNumberLast4: CryptoUtil.maskLast4(digits),
      ...(dto.khqrFileId ? { khqrFileId: dto.khqrFileId } : {}),
    };

    const previous = await this.prisma.driverPaymentSetting.findUnique({
      where: { driverId },
      select: { khqrFileId: true },
    });

    await this.prisma.driverPaymentSetting.upsert({
      where: { driverId },
      create: { driverId, ...data },
      update: data,
    });

    if (dto.khqrFileId && previous?.khqrFileId && previous.khqrFileId !== dto.khqrFileId) {
      await this.uploads.discard(previous.khqrFileId);
    }

    return this.getSettings(driverId);
  }

  // ── Requests ───────────────────────────────────────────────────────────

  async request(driverId: string, userId: string, dto: CreateWithdrawalDto): Promise<WithdrawalDto> {
    const settings = await this.prisma.driverPaymentSetting.findUnique({
      where: { driverId },
      select: { bankName: true, accountHolderName: true, accountNumberLast4: true },
    });

    if (!settings || !this.isComplete(settings)) {
      throw AppException.unprocessable(ResponseCode.WITHDRAWAL_SETTINGS_REQUIRED);
    }

    const open = await this.prisma.withdrawal.count({
      where: { driverId, status: { in: [...OPEN_STATUSES] } },
    });

    if (open > 0) {
      throw AppException.conflict(ResponseCode.WITHDRAWAL_PENDING_EXISTS);
    }

    await this.assertWithinLimits(dto.amount, dto.currency);

    const wallet = await this.wallets.getOrCreate(userId, dto.currency);
    const fee = await this.feeFor(dto.currency);

    // Reserved before the row exists: if this fails, nothing was promised.
    // The reserve itself is the authoritative check — the read above would be
    // a race on its own.
    await this.wallets.reserve(wallet.id, dto.amount);

    try {
      const withdrawal = await this.prisma.withdrawal.create({
        data: {
          driverId,
          walletId: wallet.id,
          method: dto.method,
          status: WithdrawalStatus.PENDING,
          amount: dto.amount,
          fee,
          netAmount: dto.amount - fee,
          currency: dto.currency,
          bankName: settings.bankName,
          accountHolderName: settings.accountHolderName,
          accountNumberLast4: settings.accountNumberLast4,
        },
        select: withdrawalSelect,
      });

      this.events.emit(DomainEvent.WITHDRAWAL_STATUS_CHANGED, {
        withdrawalId: withdrawal.id,
        driverId,
        status: WithdrawalStatus.PENDING,
      });

      return this.toDto(withdrawal);
    } catch (error) {
      // A reservation must never outlive a failed request.
      await this.wallets.release(wallet.id, dto.amount);
      throw error;
    }
  }

  async findAll(driverId: string, query: ListWithdrawalsQueryDto): Promise<PaginatedResult<WithdrawalDto>> {
    const where = { driverId, ...(query.status ? { status: query.status } : {}) };

    const [rows, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: withdrawalSelect,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.toDto(row)), query.page, query.limit, total);
  }

  async findOne(driverId: string, id: string): Promise<WithdrawalDto> {
    const withdrawal = await this.prisma.withdrawal.findFirst({
      where: { id, driverId },
      select: withdrawalSelect,
    });

    if (!withdrawal) {
      throw AppException.notFound(ResponseCode.WITHDRAWAL_NOT_FOUND);
    }

    return this.toDto(withdrawal);
  }

  /** A driver may withdraw the request until someone starts working on it. */
  async cancel(driverId: string, id: string): Promise<WithdrawalDto> {
    const withdrawal = await this.prisma.withdrawal.findFirst({
      where: { id, driverId },
      select: withdrawalSelect,
    });

    if (!withdrawal) {
      throw AppException.notFound(ResponseCode.WITHDRAWAL_NOT_FOUND);
    }

    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw AppException.conflict(
        ResponseCode.WITHDRAWAL_NOT_CANCELLABLE,
        'This withdrawal is already being processed.',
      );
    }

    // Conditional so two taps cannot release the reservation twice.
    const { count } = await this.prisma.withdrawal.updateMany({
      where: { id, status: WithdrawalStatus.PENDING },
      data: { status: WithdrawalStatus.CANCELLED, processedAt: new Date() },
    });

    if (count === 0) {
      throw AppException.conflict(ResponseCode.WITHDRAWAL_NOT_CANCELLABLE);
    }

    await this.wallets.release(withdrawal.walletId, withdrawal.amount);
    this.events.emit(DomainEvent.WITHDRAWAL_STATUS_CHANGED, {
      withdrawalId: id,
      driverId,
      status: WithdrawalStatus.CANCELLED,
    });

    return this.findOne(driverId, id);
  }

  // ── Settlement (called by the admin API and payout jobs) ───────────────

  async markApproved(id: string): Promise<void> {
    await this.moveTo(id, [WithdrawalStatus.PENDING], WithdrawalStatus.APPROVED);
  }

  async markProcessing(id: string): Promise<void> {
    await this.moveTo(id, [WithdrawalStatus.APPROVED], WithdrawalStatus.PROCESSING, { processedAt: new Date() });
  }

  /**
   * The only place a payout actually leaves the wallet.
   *
   * Deliberately not called when the request is approved or queued: money moves
   * when the bank says it moved, not when we hope it will.
   */
  async markSuccess(id: string, providerRef?: string): Promise<void> {
    const withdrawal = await this.prisma.withdrawal.findUniqueOrThrow({
      where: { id },
      select: withdrawalSelect,
    });

    if (withdrawal.status === WithdrawalStatus.SUCCESS) return;

    const settleable: WithdrawalStatus[] = [WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING];
    if (!settleable.includes(withdrawal.status)) {
      throw AppException.conflict(
        ResponseCode.CONFLICT,
        `A ${withdrawal.status.toLowerCase()} withdrawal cannot be settled.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.withdrawal.updateMany({
        where: { id, status: { in: settleable } },
        data: { status: WithdrawalStatus.SUCCESS, completedAt: new Date(), providerRef },
      });

      if (count === 0) {
        throw AppException.conflict(ResponseCode.CONFLICT, 'This withdrawal was already settled.');
      }

      const balances = await this.wallets.settleReserved(withdrawal.walletId, withdrawal.amount, tx);

      const entry = await tx.walletTransaction.create({
        data: {
          walletId: withdrawal.walletId,
          type: WalletTransactionType.WITHDRAWAL,
          direction: LedgerDirection.DEBIT,
          status: WalletTransactionStatus.COMPLETED,
          amount: withdrawal.amount,
          currency: withdrawal.currency,
          balanceBefore: balances.before,
          balanceAfter: balances.after,
          referenceType: 'withdrawal',
          referenceId: id,
          description: `Payout to ${withdrawal.bankName ?? 'bank'} ****${withdrawal.accountNumberLast4 ?? ''}`,
        },
        select: { id: true },
      });

      await tx.withdrawal.update({ where: { id }, data: { reserveTransactionId: entry.id } });
    });

    this.events.emit(DomainEvent.WITHDRAWAL_STATUS_CHANGED, {
      withdrawalId: id,
      driverId: withdrawal.driverId,
      status: WithdrawalStatus.SUCCESS,
    });
  }

  /** Failure and rejection both give the money back — nothing left the wallet. */
  async markFailed(id: string, reason: string, rejected = false): Promise<void> {
    const withdrawal = await this.prisma.withdrawal.findUniqueOrThrow({
      where: { id },
      select: withdrawalSelect,
    });

    const open: WithdrawalStatus[] = [...OPEN_STATUSES];
    if (!open.includes(withdrawal.status)) {
      throw AppException.conflict(ResponseCode.CONFLICT, 'This withdrawal is already finished.');
    }

    const status = rejected ? WithdrawalStatus.REJECTED : WithdrawalStatus.FAILED;

    const { count } = await this.prisma.withdrawal.updateMany({
      where: { id, status: { in: open } },
      data: {
        status,
        processedAt: new Date(),
        ...(rejected ? { rejectedReason: reason } : { failureReason: reason }),
      },
    });

    if (count === 0) return;

    await this.wallets.release(withdrawal.walletId, withdrawal.amount);
    this.events.emit(DomainEvent.WITHDRAWAL_STATUS_CHANGED, {
      withdrawalId: id,
      driverId: withdrawal.driverId,
      status,
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async moveTo(
    id: string,
    from: WithdrawalStatus[],
    to: WithdrawalStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { count } = await this.prisma.withdrawal.updateMany({
      where: { id, status: { in: from } },
      data: { status: to, ...extra },
    });

    if (count === 0) {
      throw AppException.conflict(ResponseCode.CONFLICT, `This withdrawal cannot become ${to.toLowerCase()}.`);
    }
  }

  private isComplete(settings: {
    bankName: string | null;
    accountHolderName: string | null;
    accountNumberLast4: string | null;
  }): boolean {
    return Boolean(settings.bankName && settings.accountHolderName && settings.accountNumberLast4);
  }

  /**
   * Limits are configured in riel. For another currency they are converted with
   * the stored exchange rate rather than guessed at.
   */
  private async assertWithinLimits(amount: number, currency: Currency): Promise<void> {
    const [minimum, maximum] = await Promise.all([
      this.convertFromKhr(this.config.get<number>('payout.minAmountKhr', 20_000), currency),
      this.convertFromKhr(this.config.get<number>('payout.maxAmountKhr', 4_000_000), currency),
    ]);

    if (amount < minimum) {
      throw AppException.unprocessable(
        ResponseCode.WITHDRAWAL_AMOUNT_TOO_LOW,
        `The smallest withdrawal is ${minimum} ${currency}.`,
      );
    }

    if (amount > maximum) {
      throw AppException.unprocessable(
        ResponseCode.WITHDRAWAL_AMOUNT_TOO_HIGH,
        `The largest withdrawal is ${maximum} ${currency}.`,
      );
    }
  }

  private async feeFor(currency: Currency): Promise<number> {
    return this.convertFromKhr(this.config.get<number>('payout.feeKhr', 0), currency);
  }

  private async convertFromKhr(amountKhr: number, currency: Currency): Promise<number> {
    if (currency === Currency.KHR || amountKhr === 0) return amountKhr;

    const rate = await this.prisma.exchangeRate.findFirst({
      where: { baseCurrency: Currency.KHR, quoteCurrency: currency, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: 'desc' },
      select: { rate: true },
    });

    if (!rate) {
      throw AppException.serviceUnavailable(
        ResponseCode.SERVICE_UNAVAILABLE,
        `No exchange rate is configured for KHR to ${currency}.`,
      );
    }

    // KHR has no minor unit; USD has cents — hence the ×100.
    return Math.round(amountKhr * Number(rate.rate) * 100);
  }

  private toDto(withdrawal: {
    id: string;
    status: WithdrawalStatus;
    method: WithdrawalDto['method'];
    amount: number;
    fee: number;
    netAmount: number;
    currency: Currency;
    bankName: string | null;
    accountHolderName: string | null;
    accountNumberLast4: string | null;
    rejectedReason: string | null;
    failureReason: string | null;
    requestedAt: Date;
    processedAt: Date | null;
    completedAt: Date | null;
  }): WithdrawalDto {
    return {
      id: withdrawal.id,
      status: withdrawal.status,
      method: withdrawal.method,
      amount: withdrawal.amount,
      fee: withdrawal.fee,
      netAmount: withdrawal.netAmount,
      currency: withdrawal.currency,
      bankName: withdrawal.bankName,
      accountHolderName: withdrawal.accountHolderName,
      accountNumberLast4: withdrawal.accountNumberLast4,
      failureReason: withdrawal.rejectedReason ?? withdrawal.failureReason,
      canCancel: withdrawal.status === WithdrawalStatus.PENDING,
      requestedAt: withdrawal.requestedAt.toISOString(),
      processedAt: withdrawal.processedAt?.toISOString() ?? null,
      completedAt: withdrawal.completedAt?.toISOString() ?? null,
    };
  }
}
