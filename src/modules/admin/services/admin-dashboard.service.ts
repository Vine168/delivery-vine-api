import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ACTIVE_DELIVERY_STATUSES } from '../../../common/constants/delivery-status.js';
import { TimeUtil } from '../../../common/utils/time.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  Currency,
  DeliveryStatus,
  DocumentReviewStatus,
  DriverApprovalStatus,
  RefundStatus,
  WithdrawalStatus,
} from '../../../generated/prisma/enums.js';
import { DriverPresenceService } from '../../driver-presence/driver-presence.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import type {
  AdminDashboardDto,
  AdminDashboardQueryDto,
  AdminRevenueDto,
  AdminTrendPointDto,
} from '../dto/admin-dashboard.dto.js';

const DEFAULT_WINDOW_DAYS = 13;

interface TrendRow {
  day: string;
  currency: Currency | null;
  deliveries: bigint;
  delivered: bigint;
  cancelled: bigint;
  gross: bigint | null;
}

/**
 * The operations home screen.
 *
 * Two rules shape everything here. Money is never summed across currencies —
 * the platform runs KHR and USD side by side, and a single "total revenue"
 * figure would be a lie — so every monetary total is reported per currency in
 * minor units. And dates are bucketed in the platform's reporting timezone,
 * not the server's, so "today" means the same thing wherever this runs.
 */
@Injectable()
export class AdminDashboardService {
  private readonly timezone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
    private readonly settings: SettingsService,
    config: ConfigService,
  ) {
    this.timezone = config.get<string>('app.timezone', 'Asia/Phnom_Penh');
  }

  async overview(query: AdminDashboardQueryDto): Promise<AdminDashboardDto> {
    const to = query.dateTo ? TimeUtil.startOfDay(this.timezone, new Date(query.dateTo)) : TimeUtil.startOfDay(this.timezone);
    const from = query.dateFrom
      ? TimeUtil.startOfDay(this.timezone, new Date(query.dateFrom))
      : TimeUtil.addDays(to, -DEFAULT_WINDOW_DAYS);
    const toExclusive = TimeUtil.addDays(to, 1);

    const inRange: Prisma.DeliveryWhereInput = {
      deletedAt: null,
      // A draft was never booked; counting it would inflate every ratio.
      status: { not: DeliveryStatus.DRAFT },
      createdAt: { gte: from, lt: toExclusive },
    };

    // How long counts as stuck is an operator's judgement, not a constant.
    const stalledAfterMinutes = await this.settings.getNumber('delivery.stalledAfterMinutes');
    const stalledSince = new Date(Date.now() - stalledAfterMinutes * 60_000);

    const [
      statusGroups,
      revenueGroups,
      activeNow,
      searchingNow,
      stalledNow,
      driverGroups,
      driverTotal,
      customerTotal,
      newCustomers,
      orderingCustomers,
      pendingDocuments,
      pendingWithdrawals,
      pendingRefunds,
      vehicleTypeCodes,
      trendRows,
    ] = await Promise.all([
      this.prisma.delivery.groupBy({ by: ['status'], where: inRange, _count: { _all: true } }),
      this.prisma.delivery.groupBy({
        by: ['currency'],
        where: { ...inRange, status: DeliveryStatus.DELIVERED },
        _count: { _all: true },
        _sum: { totalAmount: true, commissionAmount: true, driverEarningAmount: true },
      }),
      this.prisma.delivery.count({
        where: { deletedAt: null, status: { in: [...ACTIVE_DELIVERY_STATUSES] } },
      }),
      this.prisma.delivery.count({
        where: { deletedAt: null, status: DeliveryStatus.SEARCHING_DRIVER },
      }),
      this.prisma.delivery.count({
        where: {
          deletedAt: null,
          status: DeliveryStatus.SEARCHING_DRIVER,
          confirmedAt: { lte: stalledSince },
        },
      }),
      this.prisma.driverProfile.groupBy({
        by: ['approvalStatus'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.driverProfile.count({ where: { deletedAt: null } }),
      this.prisma.customerProfile.count(),
      this.prisma.customerProfile.count({ where: { createdAt: { gte: from, lt: toExclusive } } }),
      this.countOrderingCustomers(from, toExclusive),
      this.prisma.driverDocument.count({ where: { status: DocumentReviewStatus.PENDING } }),
      this.prisma.withdrawal.count({ where: { status: WithdrawalStatus.PENDING } }),
      this.prisma.refund.count({ where: { status: RefundStatus.PENDING } }),
      this.prisma.vehicleType.findMany({ where: { isActive: true }, select: { code: true } }),
      this.trendRows(from, toExclusive),
    ]);

    const online = await this.presence.countOnline(vehicleTypeCodes.map((type) => type.code));

    const countOf = (status: DeliveryStatus): number =>
      statusGroups.find((group) => group.status === status)?._count._all ?? 0;

    const total = statusGroups.reduce((sum, group) => sum + group._count._all, 0);
    const delivered = countOf(DeliveryStatus.DELIVERED);
    const cancelled = countOf(DeliveryStatus.CANCELLED);
    const expired = countOf(DeliveryStatus.EXPIRED);
    const finished = delivered + cancelled + expired;

    const driversOf = (status: DriverApprovalStatus): number =>
      driverGroups.find((group) => group.approvalStatus === status)?._count._all ?? 0;

    return {
      dateFrom: TimeUtil.dayKey(this.timezone, from),
      dateTo: TimeUtil.dayKey(this.timezone, to),
      timezone: this.timezone,
      deliveries: {
        total,
        delivered,
        cancelled,
        expired,
        active: activeNow,
        searching: searchingNow,
        // Out of the bookings that reached an end — a delivery still in flight
        // has not succeeded or failed yet, and counting it as a failure would
        // make the rate sag every time business is busy.
        completionRateBps: finished === 0 ? 0 : Math.round((delivered / finished) * 10_000),
      },
      statusBreakdown: statusGroups
        .map((group) => ({ status: group.status, count: group._count._all }))
        .sort((a, b) => b.count - a.count),
      revenue: this.toRevenue(revenueGroups),
      drivers: {
        total: driverTotal,
        active: driversOf(DriverApprovalStatus.ACTIVE),
        pendingApproval: driversOf(DriverApprovalStatus.PENDING_APPROVAL),
        suspended: driversOf(DriverApprovalStatus.SUSPENDED),
        onlineNow: online.online,
        busyNow: online.busy,
      },
      customers: {
        total: customerTotal,
        newInRange: newCustomers,
        orderedInRange: orderingCustomers,
      },
      attention: {
        driverApprovals: driversOf(DriverApprovalStatus.PENDING_APPROVAL),
        documentReviews: pendingDocuments,
        withdrawals: pendingWithdrawals,
        refunds: pendingRefunds,
        stalledDeliveries: stalledNow,
      },
      trend: this.toTrend(trendRows, from, to),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private toRevenue(
    groups: {
      currency: Currency;
      _count: { _all: number };
      _sum: {
        totalAmount: number | null;
        commissionAmount: number | null;
        driverEarningAmount: number | null;
      };
    }[],
  ): AdminRevenueDto[] {
    return groups.map((group) => {
      const gross = group._sum.totalAmount ?? 0;
      const deliveredCount = group._count._all;

      return {
        currency: group.currency,
        grossAmount: gross,
        commissionAmount: group._sum.commissionAmount ?? 0,
        driverEarningAmount: group._sum.driverEarningAmount ?? 0,
        deliveredCount,
        averageOrderValue: deliveredCount === 0 ? 0 : Math.round(gross / deliveredCount),
      };
    });
  }

  /**
   * How many distinct customers booked in the window.
   *
   * Raw because Prisma has no COUNT(DISTINCT): grouping by customerId would
   * pull one row per customer back into the process to be counted.
   */
  private async countOrderingCustomers(from: Date, toExclusive: Date): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "customerId")::bigint AS count
      FROM "Delivery"
      WHERE "deletedAt" IS NULL
        AND "status" <> 'DRAFT'
        AND "createdAt" >= ${from}
        AND "createdAt" < ${toExclusive}
    `;

    return Number(row?.count ?? 0);
  }

  /**
   * Daily counts and gross revenue, bucketed by calendar day in the reporting
   * timezone. Grouped in Postgres so the API never loads a window's worth of
   * deliveries to add them up.
   */
  private async trendRows(from: Date, toExclusive: Date): Promise<TrendRow[]> {
    return this.prisma.$queryRaw<TrendRow[]>`
      SELECT
        to_char(date_trunc('day', "createdAt" AT TIME ZONE ${this.timezone}), 'YYYY-MM-DD') AS day,
        CASE WHEN "status" = 'DELIVERED' THEN "currency" ELSE NULL END AS currency,
        COUNT(*)::bigint AS deliveries,
        (COUNT(*) FILTER (WHERE "status" = 'DELIVERED'))::bigint AS delivered,
        (COUNT(*) FILTER (WHERE "status" = 'CANCELLED'))::bigint AS cancelled,
        (SUM("totalAmount") FILTER (WHERE "status" = 'DELIVERED'))::bigint AS gross
      FROM "Delivery"
      WHERE "deletedAt" IS NULL
        AND "status" <> 'DRAFT'
        AND "createdAt" >= ${from}
        AND "createdAt" < ${toExclusive}
      GROUP BY 1, 2
      ORDER BY 1
    `;
  }

  /** Fills in the days nothing happened, so a chart has no holes in it. */
  private toTrend(rows: TrendRow[], from: Date, to: Date): AdminTrendPointDto[] {
    const byDay = new Map<string, AdminTrendPointDto>();

    for (const key of TimeUtil.dayKeysBetween(this.timezone, from, to)) {
      byDay.set(key, { date: key, deliveries: 0, delivered: 0, cancelled: 0, revenue: [] });
    }

    for (const row of rows) {
      const point = byDay.get(row.day);
      if (!point) continue;

      point.deliveries += Number(row.deliveries);
      point.delivered += Number(row.delivered);
      point.cancelled += Number(row.cancelled);

      if (row.currency && row.gross !== null) {
        point.revenue.push({ currency: row.currency, amount: Number(row.gross) });
      }
    }

    return [...byDay.values()];
  }
}
