import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isPrismaKnownError } from '../../database/prisma-exception.util.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  Currency,
  LedgerDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../../generated/prisma/enums.js';

type Tx = Prisma.TransactionClient;

export interface LedgerEntryInput {
  userId: string;
  currency: Currency;
  type: WalletTransactionType;
  amount: number;
  /** What this entry is for — `delivery`, `withdrawal`, `adjustment`… */
  referenceType: string;
  referenceId?: string | null;
  description?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface LedgerEntry {
  transactionId: string;
  walletId: string;
  balanceBefore: number;
  balanceAfter: number;
  /** False when this exact entry already existed and nothing changed. */
  applied: boolean;
}

/**
 * The driver wallet.
 *
 * Two rules hold everything together:
 *
 *  1. The balance only ever changes inside a transaction that also writes the
 *     matching WalletTransaction. There is no code path that moves money
 *     without leaving a row explaining it.
 *  2. Every write is a conditional UPDATE. Concurrent debits cannot overdraw
 *     because the row only changes when it still has the funds, and the
 *     database carries CHECK constraints as a last line of defence.
 *
 * `balance` is the total; `reservedBalance` is the part already committed to a
 * pending withdrawal. Spendable money is the difference.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(userId: string, currency: Currency, tx: Tx | PrismaService = this.prisma) {
    const existing = await tx.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
      select: walletSelect,
    });

    if (existing) return existing;

    return tx.wallet.create({
      data: { userId, currency },
      select: walletSelect,
    });
  }

  async findAll(userId: string) {
    return this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { currency: 'asc' },
      select: walletSelect,
    });
  }

  /**
   * Adds money. Idempotent by (wallet, referenceType, referenceId, type): a
   * retried job credits a driver once, not twice.
   */
  async credit(input: LedgerEntryInput, tx: Tx): Promise<LedgerEntry> {
    this.assertPositive(input.amount);
    const wallet = await this.getOrCreate(input.userId, input.currency, tx);

    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET "balance" = "balance" + ${input.amount}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "id" = ${wallet.id}
    `;

    if (updated === 0) {
      throw AppException.internal('The wallet could not be credited.');
    }

    return this.record(tx, wallet.id, input, LedgerDirection.CREDIT, input.amount);
  }

  /**
   * Removes money, refusing to go below zero.
   *
   * The `WHERE balance - reservedBalance >= amount` clause is what makes two
   * simultaneous debits safe: the second one matches no rows and is told the
   * balance is insufficient, instead of both succeeding.
   */
  async debit(input: LedgerEntryInput, tx: Tx): Promise<LedgerEntry> {
    this.assertPositive(input.amount);
    const wallet = await this.getOrCreate(input.userId, input.currency, tx);

    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET "balance" = "balance" - ${input.amount}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "id" = ${wallet.id} AND ("balance" - "reservedBalance") >= ${input.amount}
    `;

    if (updated === 0) {
      throw AppException.unprocessable(ResponseCode.INSUFFICIENT_BALANCE);
    }

    return this.record(tx, wallet.id, input, LedgerDirection.DEBIT, -input.amount);
  }

  /**
   * Earmarks money for a pending withdrawal without removing it.
   *
   * The funds stay in `balance` (so the ledger still balances) but leave the
   * spendable pool, which is what stops a driver requesting the same money
   * twice in two taps.
   */
  async reserve(walletId: string, amount: number): Promise<void> {
    this.assertPositive(amount);

    const updated = await this.prisma.$executeRaw`
      UPDATE "Wallet"
      SET "reservedBalance" = "reservedBalance" + ${amount}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "id" = ${walletId} AND ("balance" - "reservedBalance") >= ${amount}
    `;

    if (updated === 0) {
      throw AppException.unprocessable(ResponseCode.INSUFFICIENT_BALANCE);
    }
  }

  /** Frees a reservation — a rejected, failed or cancelled withdrawal. */
  async release(walletId: string, amount: number, tx: Tx | PrismaService = this.prisma): Promise<void> {
    await tx.$executeRaw`
      UPDATE "Wallet"
      SET "reservedBalance" = GREATEST("reservedBalance" - ${amount}, 0),
          "version" = "version" + 1,
          "updatedAt" = now()
      WHERE "id" = ${walletId}
    `;
  }

  /**
   * Settles a reservation: the money leaves both the reservation and the
   * balance, in one statement so the two can never disagree.
   */
  async settleReserved(walletId: string, amount: number, tx: Tx): Promise<{ before: number; after: number }> {
    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET "balance" = "balance" - ${amount},
          "reservedBalance" = GREATEST("reservedBalance" - ${amount}, 0),
          "version" = "version" + 1,
          "updatedAt" = now()
      WHERE "id" = ${walletId} AND "balance" >= ${amount} AND "reservedBalance" >= ${amount}
    `;

    if (updated === 0) {
      throw AppException.unprocessable(ResponseCode.INSUFFICIENT_BALANCE);
    }

    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { balance: true } });
    return { before: wallet.balance + amount, after: wallet.balance };
  }

  /** Spendable money: the balance minus anything already promised. */
  availableOf(wallet: { balance: number; reservedBalance: number }): number {
    return wallet.balance - wallet.reservedBalance;
  }

  /**
   * Writes the ledger row and derives the before/after from the balance the
   * UPDATE just produced — so the numbers on the row are the numbers the
   * database actually holds, not a value read before the write.
   */
  private async record(
    tx: Tx,
    walletId: string,
    input: LedgerEntryInput,
    direction: LedgerDirection,
    delta: number,
  ): Promise<LedgerEntry> {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { balance: true } });
    const balanceAfter = wallet.balance;
    const balanceBefore = balanceAfter - delta;

    try {
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId,
          type: input.type,
          direction,
          status: WalletTransactionStatus.COMPLETED,
          amount: input.amount,
          currency: input.currency,
          balanceBefore,
          balanceAfter,
          referenceType: input.referenceType,
          referenceId: input.referenceId ?? null,
          description: input.description,
          metadata: input.metadata,
        },
        select: { id: true },
      });

      return { transactionId: transaction.id, walletId, balanceBefore, balanceAfter, applied: true };
    } catch (error) {
      // The unique index on (wallet, referenceType, referenceId, type) means a
      // replayed job hits this instead of paying twice.
      if (isPrismaKnownError(error) && error.code === 'P2002') {
        throw new DuplicateLedgerEntryError(input);
      }
      throw error;
    }
  }

  private assertPositive(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw AppException.badRequest(
        ResponseCode.VALIDATION_ERROR,
        'A ledger amount must be a positive whole number of minor units.',
      );
    }
  }
}

/** Thrown when an entry with the same reference already exists. */
export class DuplicateLedgerEntryError extends Error {
  constructor(readonly input: LedgerEntryInput) {
    super(`Ledger entry already exists for ${input.referenceType}:${input.referenceId}`);
    this.name = 'DuplicateLedgerEntryError';
  }
}

const walletSelect = {
  id: true,
  userId: true,
  currency: true,
  balance: true,
  reservedBalance: true,
  version: true,
  updatedAt: true,
} as const;
