import { Injectable } from '@nestjs/common';
import { IN_FLIGHT_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  AssignmentStatus,
  Currency,
  DeliveryStatus,
  DriverAvailabilityStatus,
  EarningStatus,
} from '../../generated/prisma/enums.js';
import { DriverReadinessService } from '../drivers/driver-readiness.service.js';
import { DriverAvailabilityService } from './driver-availability.service.js';
import type { DriverDashboardDto } from './dto/dashboard.dto.js';

/**
 * The driver home screen in one request.
 *
 * Deliberately an aggregate: the alternative is ten round trips on a phone
 * connection every time the driver opens the app. Every figure here is cheap —
 * counts and one sum — and none of it is derived on the client.
 */
@Injectable()
export class DriverDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: DriverAvailabilityService,
    private readonly readiness: DriverReadinessService,
  ) {}

  async get(driverId: string, currency: Currency = Currency.KHR): Promise<DriverDashboardDto> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(startOfDay);
    // Monday as the first day of the week.
    startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));

    const [
      driver,
      availabilityRow,
      onlineSecondsToday,
      readiness,
      earningsToday,
      earningsThisWeek,
      newRequests,
      ongoing,
      completedToday,
      cancelledToday,
    ] = await Promise.all([
      this.prisma.driverProfile.findUniqueOrThrow({
        where: { id: driverId },
        select: {
          ratingAverage: true,
          ratingCount: true,
          completedDeliveries: true,
          offeredJobs: true,
          acceptedJobs: true,
        },
      }),
      this.prisma.driverAvailability.findUnique({
        where: { driverId },
        select: { status: true, onlineSinceAt: true },
      }),
      this.availability.onlineSecondsToday(driverId),
      this.readiness.evaluate(driverId),
      this.sumEarnings(driverId, currency, startOfDay),
      this.sumEarnings(driverId, currency, startOfWeek),
      this.prisma.deliveryAssignment.count({
        where: { driverId, status: AssignmentStatus.OFFERED, expiresAt: { gt: new Date() } },
      }),
      this.prisma.delivery.count({ where: { driverId, status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } } }),
      this.prisma.delivery.count({
        where: { driverId, status: DeliveryStatus.DELIVERED, deliveredAt: { gte: startOfDay } },
      }),
      this.prisma.delivery.count({
        where: { driverId, status: DeliveryStatus.CANCELLED, cancelledAt: { gte: startOfDay } },
      }),
    ]);

    return {
      availability: availabilityRow?.status ?? DriverAvailabilityStatus.OFFLINE,
      onlineSinceAt: availabilityRow?.onlineSinceAt?.toISOString() ?? null,
      onlineSecondsToday,
      acceptanceRate:
        driver.offeredJobs > 0 ? Number((driver.acceptedJobs / driver.offeredJobs).toFixed(2)) : 0,
      ratingAverage: Number(driver.ratingAverage),
      ratingCount: driver.ratingCount,
      earnings: { today: earningsToday, thisWeek: earningsThisWeek, currency },
      counts: {
        newRequests,
        ongoing,
        completedToday,
        cancelledToday,
        completedAllTime: driver.completedDeliveries,
      },
      canGoOnline: readiness.canGoOnline,
      blockers: readiness.blockers,
    };
  }

  /** Cancelled or reversed earnings are excluded by status, not by deletion. */
  private async sumEarnings(driverId: string, currency: Currency, since: Date): Promise<number> {
    const result = await this.prisma.driverEarning.aggregate({
      where: {
        driverId,
        currency,
        earnedAt: { gte: since },
        status: { in: [EarningStatus.PENDING, EarningStatus.AVAILABLE, EarningStatus.PAID] },
      },
      _sum: { netAmount: true },
    });

    return result._sum.netAmount ?? 0;
  }
}
