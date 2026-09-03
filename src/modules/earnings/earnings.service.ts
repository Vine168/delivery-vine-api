import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PaginationUtil } from '../../common/utils/pagination.util.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Currency, EarningStatus, WalletTransactionType } from '../../generated/prisma/enums.js';
import { DuplicateLedgerEntryError, WalletService } from '../wallets/wallet.service.js';
import {
  EarningsPeriod,
  type EarningDto,
  type EarningsHistoryQueryDto,
  type EarningsSummaryDto,
  type EarningsSummaryQueryDto,
} from './dto/earning.dto.js';

const earningSelect = {
  id: true,
  deliveryId: true,
  currency: true,
  deliveryAmount: true,
  commissionPercentBp: true,
  commissionAmount: true,
  tipAmount: true,
  bonusAmount: true,
  netAmount: true,
  status: true,
  walletTransactionId: true,
  earnedAt: true,
  delivery: {
    select: { bookingCode: true, pickupAddress: true, dropoffAddress: true, distanceMeters: true },
  },
} as const;

@Injectable()
export class EarningsService {
  private readonly logger = new Logger(EarningsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
  ) {}

  /**
   * Pays a completed delivery into the driver's wallet.
   *
   * The earning snapshot already exists — it was written when the delivery was
   * completed. This turns it into money, in one transaction that both credits
   * the ledger and marks the earning settled, so the two can never disagree.
   * Re-running it is safe: the ledger's uniqueness constraint makes a repeat
   * a no-op rather than a second payment.
   */
  async settle(deliveryId: string): Promise<void> {
    const earning = await this.prisma.driverEarning.findUnique({
      where: { deliveryId },
      select: {
        id: true,
        driverId: true,
        currency: true,
        netAmount: true,
        status: true,
        driver: { select: { userId: true } },
        delivery: { select: { bookingCode: true } },
      },
    });

    if (!earning) {
      this.logger.warn(`No earning to settle for delivery ${deliveryId}`);
      return;
    }

    if (earning.status !== EarningStatus.PENDING) {
      return;
    }

    if (earning.netAmount <= 0) {
      // Nothing to pay, but the earning should not sit PENDING forever.
      await this.prisma.driverEarning.update({
        where: { id: earning.id },
        data: { status: EarningStatus.AVAILABLE },
      });
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const entry = await this.wallets.credit(
          {
            userId: earning.driver.userId,
            currency: earning.currency,
            type: WalletTransactionType.DELIVERY_EARNING,
            amount: earning.netAmount,
            referenceType: 'delivery',
            referenceId: deliveryId,
            description: `Delivery ${earning.delivery.bookingCode}`,
          },
          tx,
        );

        await tx.driverEarning.update({
          where: { id: earning.id },
          data: { status: EarningStatus.AVAILABLE, walletTransactionId: entry.transactionId },
        });
      });

      this.logger.log(`Credited ${earning.netAmount} ${earning.currency} for ${earning.delivery.bookingCode}`);
    } catch (error) {
      if (error instanceof DuplicateLedgerEntryError) {
        // Already paid on a previous attempt — reconcile the earning and move on.
        await this.prisma.driverEarning.updateMany({
          where: { id: earning.id, status: EarningStatus.PENDING },
          data: { status: EarningStatus.AVAILABLE },
        });
        return;
      }
      throw error;
    }
  }

  async summary(driverId: string, query: EarningsSummaryQueryDto): Promise<EarningsSummaryDto> {
    const { from, to } = this.periodBounds(query.period);

    const totals = await this.prisma.driverEarning.aggregate({
      where: {
        driverId,
        currency: query.currency,
        earnedAt: { gte: from, lte: to },
        status: { in: [EarningStatus.PENDING, EarningStatus.AVAILABLE, EarningStatus.PAID] },
      },
      _sum: { deliveryAmount: true, commissionAmount: true, netAmount: true },
      _count: { _all: true },
    });

    const deliveryCount = totals._count._all;
    const netAmount = totals._sum.netAmount ?? 0;

    return {
      period: query.period,
      from: from.toISOString(),
      to: to.toISOString(),
      currency: query.currency,
      deliveryCount,
      grossAmount: totals._sum.deliveryAmount ?? 0,
      commissionAmount: totals._sum.commissionAmount ?? 0,
      netAmount,
      averagePerDelivery: deliveryCount > 0 ? Math.round(netAmount / deliveryCount) : 0,
    };
  }

  async history(driverId: string, query: EarningsHistoryQueryDto): Promise<PaginatedResult<EarningDto>> {
    const where = {
      driverId,
      currency: query.currency,
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.driverEarning.findMany({
        where,
        orderBy: { earnedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: earningSelect,
      }),
      this.prisma.driverEarning.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.toDto(row)), query.page, query.limit, total);
  }

  async findOne(driverId: string, id: string): Promise<EarningDto> {
    const earning = await this.prisma.driverEarning.findFirst({
      where: { id, driverId },
      select: earningSelect,
    });

    if (!earning) {
      throw AppException.notFound(ResponseCode.EARNING_NOT_FOUND);
    }

    return this.toDto(earning);
  }

  /** Local calendar bounds — a driver's "today" is their day, not UTC's. */
  private periodBounds(period: EarningsPeriod): { from: Date; to: Date } {
    const to = new Date();
    const from = new Date();
    from.setHours(0, 0, 0, 0);

    if (period === EarningsPeriod.WEEK) {
      // Monday as the first day of the week.
      from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    } else if (period === EarningsPeriod.MONTH) {
      from.setDate(1);
    }

    return { from, to };
  }

  private toDto(earning: {
    id: string;
    deliveryId: string;
    currency: Currency;
    deliveryAmount: number;
    commissionPercentBp: number;
    commissionAmount: number;
    tipAmount: number;
    bonusAmount: number;
    netAmount: number;
    status: EarningStatus;
    walletTransactionId: string | null;
    earnedAt: Date;
    delivery: { bookingCode: string; pickupAddress: string; dropoffAddress: string; distanceMeters: number } | null;
  }): EarningDto {
    return {
      id: earning.id,
      deliveryId: earning.deliveryId,
      bookingCode: earning.delivery?.bookingCode ?? '',
      currency: earning.currency,
      deliveryAmount: earning.deliveryAmount,
      commissionPercentBp: earning.commissionPercentBp,
      commissionAmount: earning.commissionAmount,
      tipAmount: earning.tipAmount,
      bonusAmount: earning.bonusAmount,
      netAmount: earning.netAmount,
      status: earning.status,
      walletTransactionId: earning.walletTransactionId,
      pickupAddress: earning.delivery?.pickupAddress ?? null,
      dropoffAddress: earning.delivery?.dropoffAddress ?? null,
      distanceMeters: earning.delivery?.distanceMeters ?? null,
      earnedAt: earning.earnedAt.toISOString(),
    };
  }
}
